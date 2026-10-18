import { clearGamesPlaytimeState } from "./game-running-state";
import { clearStaleEpicImports } from "./epic/import-cleanup";
import axios, { AxiosError, AxiosInstance } from "axios";
import jwt from "jsonwebtoken";
import { WindowManager } from "./window-manager";
import url from "url";
import { uploadGamesBatch } from "./library-sync";
import { clearGamesRemoteIds } from "./library-sync/clear-games-remote-id";
import { networkLogger as logger } from "./logger";
import { UserNotLoggedInError, SubscriptionRequiredError } from "@shared";
import { appVersion } from "@main/constants";
import { getUserData } from "./user/get-user-data";
import { db } from "@main/level";
import { levelKeys } from "@main/level/sublevels";
import type { Auth, User } from "@types";
import { SSEClient } from "./sse";
import { FriendsSnapshotCache } from "./friends-snapshot";
import { ChatUnreadStore } from "./chat/chat-unread-store";
import { clearChatSenderProfiles } from "./chat/chat-sender-profiles";
import { closeChatNotifications } from "./notifications";
import { trimTrailingSlashes } from "../../shared/trim-trailing-slashes.js";
import {
  sanitizeNetworkLogPayload,
  summarizeNetworkLogPayload,
} from "./network-log-payload";
import { summarizeNetworkError } from "./network-error-summary";
import {
  HydraAuthContextTracker,
  waitForHydraAuthRefresh,
  type HydraApiAuthContext,
} from "./hydra-auth-context";

declare module "axios" {
  interface AxiosRequestConfig {
    logResponseBody?: boolean;
  }
}

export interface HydraApiOptions {
  needsAuth?: boolean;
  needsSubscription?: boolean;
  ifModifiedSince?: Date;
  ifNoneMatch?: string;
  validateStatus?: (status: number) => boolean;
  signal?: AbortSignal;
  logResponseBody?: boolean;
  timeout?: number;
  authContext?: HydraApiAuthContext;
}

interface HydraApiUserAuth {
  authToken: string;
  refreshToken: string;
  expirationTimestamp: number;
  subscription: { expiresAt: Date | string | null } | null;
}

export class HydraApi {
  private static instance: AxiosInstance;
  private static officialInstance: AxiosInstance;
  private static readonly authContexts = new HydraAuthContextTracker();
  private static authPersistence: Promise<void> = Promise.resolve();
  private static refreshInFlight: {
    generation: number;
    promise: Promise<{ accessToken: string; expiresIn: number }>;
  } | null = null;

  public static getAuthContext() {
    return this.authContexts.getContext();
  }

  public static isAuthContextCurrent(context: HydraApiAuthContext) {
    return this.authContexts.isCurrent(context);
  }

  public static onAuthContextChanged(listener: () => void) {
    return this.authContexts.subscribe(listener);
  }

  /* The account that owns the local library: the self-hosted user while a
     self-hosted session is active (fork), otherwise the official user. */
  private static resolveAuthIdentity() {
    if (this.selfHostedConfig?.userToken) {
      const claims = jwt.decode(this.selfHostedConfig.userToken);
      return {
        environment: trimTrailingSlashes(this.selfHostedConfig.url),
        userId:
          claims && typeof claims === "object" && typeof claims.sub === "string"
            ? claims.sub
            : null,
      };
    }

    const claims = jwt.decode(this.userAuth.authToken);
    return {
      environment: trimTrailingSlashes(import.meta.env.MAIN_VITE_API_URL),
      userId:
        claims &&
        typeof claims === "object" &&
        typeof claims.userId === "string"
          ? claims.userId
          : null,
    };
  }

  private static activateAuthContext(generation: number) {
    const { environment, userId } = this.resolveAuthIdentity();
    this.authContexts.activate(environment, userId, generation);
  }

  /* Starts a new auth generation when the library owner changes, e.g. on
     self-hosted sign-in/out, so in-flight work for the old owner is dropped. */
  private static syncAuthContextIdentity() {
    const next = this.resolveAuthIdentity();
    const current = this.getAuthContext();
    if (
      current?.environment === next.environment &&
      current?.userId === next.userId
    ) {
      return;
    }
    if (!current && !next.userId) return;
    this.activateAuthContext(this.authContexts.invalidate());
  }

  private static assertAuthGeneration(generation: number) {
    if (generation !== this.authContexts.generation) {
      throw new UserNotLoggedInError();
    }
  }

  private static persistAuth(auth: Auth, generation: number) {
    return this.queueAuthPersistence(async () => {
      this.assertAuthGeneration(generation);
      await db.put<string, Auth>(levelKeys.auth, auth, {
        valueEncoding: "json",
      });
      this.assertAuthGeneration(generation);
    });
  }

  private static queueAuthPersistence(operation: () => Promise<void>) {
    const write = this.authPersistence.then(operation);
    this.authPersistence = write.catch(() => {});
    return write;
  }

  public static persistUserCache(user: User, context: HydraApiAuthContext) {
    return this.queueAuthPersistence(async () => {
      if (!this.isAuthContextCurrent(context)) throw new UserNotLoggedInError();
      await db.put<string, User>(levelKeys.user, user, {
        valueEncoding: "json",
      });
      if (!this.isAuthContextCurrent(context)) throw new UserNotLoggedInError();
    });
  }

  private static clearPersistedAuth(cleanupUserData?: () => Promise<void>) {
    // Queue immediately when the session is invalidated. A preceding write must
    // finish before deletion; a later login persists only after deletion/cleanup.
    return this.queueAuthPersistence(async () => {
      await db.batch([
        { type: "del", key: levelKeys.auth },
        { type: "del", key: levelKeys.user },
      ]);
      await cleanupUserData?.();
    });
  }

  private static readonly EXPIRATION_OFFSET_IN_MS = 1000 * 60 * 5; // 5 minutes
  private static readonly AUTH_REFRESH_TIMEOUT_MS = 20_000;
  private static readonly ADD_LOG_INTERCEPTOR = true;

  private static readonly OFFICIAL_ONLY_PREFIXES = [
    "/catalogue",
    "/games/",
    "/decky",
    "/auth/ws",
    "/download-sources",
  ];

  private static readonly OFFICIAL_ONLY_SUFFIXES = ["/reviews"];

  private static selfHostedConfig: {
    url: string;
    masterToken: string;
    userToken: string | null;
  } | null = null;

  public static useSelfHostedCatalogue = false;
  public static useSelfHostedReviews = false;
  public static useSelfHostedSocial = false;
  public static useSelfHostedDownloadSources = false;
  public static useSelfHostedHltb = false;
  public static useSelfHostedProtondb = false;

  public static setSelfHostedConfig(
    url: string,
    masterToken: string,
    userToken?: string | null,
    flags?: {
      useSelfHostedCatalogue?: boolean;
      useSelfHostedReviews?: boolean;
      useSelfHostedSocial?: boolean;
      useSelfHostedDownloadSources?: boolean;
    }
  ) {
    this.selfHostedConfig = { url, masterToken, userToken: userToken ?? null };
    if (this.instance) this.instance.defaults.baseURL = url;
    if (flags) {
      if (flags.useSelfHostedCatalogue !== undefined)
        this.useSelfHostedCatalogue = flags.useSelfHostedCatalogue;
      if (flags.useSelfHostedReviews !== undefined)
        this.useSelfHostedReviews = flags.useSelfHostedReviews;
      if (flags.useSelfHostedSocial !== undefined)
        this.useSelfHostedSocial = flags.useSelfHostedSocial;
      if (flags.useSelfHostedDownloadSources !== undefined)
        this.useSelfHostedDownloadSources = flags.useSelfHostedDownloadSources;
    }
    this.syncAuthContextIdentity();
  }

  public static setSelfHostedUserToken(userToken: string) {
    if (this.selfHostedConfig) this.selfHostedConfig.userToken = userToken;
    this.syncAuthContextIdentity();
  }

  public static clearSelfHostedConfig() {
    this.selfHostedConfig = null;
    if (this.instance)
      this.instance.defaults.baseURL = import.meta.env.MAIN_VITE_API_URL;
    this.syncAuthContextIdentity();
  }

  public static isSelfHosted() {
    return this.selfHostedConfig !== null;
  }

  public static getOfficialUserAuth() {
    if (!this.userAuth.authToken) return null;
    return this.userAuth;
  }

  public static async getOfficialProfile() {
    if (!this.userAuth.authToken) return null;
    return this.officialInstance
      .get("/profile/me", {
        headers: { Authorization: `Bearer ${this.userAuth.authToken}` },
      })
      .then((r) => r.data)
      .catch(() => null);
  }

  public static isSelfHostedAuthenticated() {
    return this.selfHostedConfig?.userToken != null;
  }

  private static officialAuthHeaders() {
    if (!this.userAuth.authToken) return {};
    return { Authorization: `Bearer ${this.userAuth.authToken}` };
  }

  public static async patchOfficial<T = unknown>(
    url: string,
    data?: unknown
  ): Promise<T> {
    return this.officialInstance
      .patch<T>(url, data, { headers: this.officialAuthHeaders() })
      .then((r) => r.data);
  }

  public static async postOfficial<T = unknown>(
    url: string,
    data?: unknown
  ): Promise<T> {
    return this.officialInstance
      .post<T>(url, data, { headers: this.officialAuthHeaders() })
      .then((r) => r.data);
  }

  // Routes catalogue requests to self-hosted if enabled, else official
  public static async cataloguePost<T = any>(
    url: string,
    data?: any
  ): Promise<T> {
    if (this.useSelfHostedCatalogue && this.selfHostedConfig) {
      const { default: axios } = await import("axios");
      return axios
        .post<T>(`${this.selfHostedConfig.url}${url}`, data, { timeout: 10000 })
        .then((r) => r.data);
    }
    return this.postOfficial<T>(url, data);
  }

  public static async catalogueGet<T = any>(
    url: string,
    params?: any
  ): Promise<T> {
    if (this.useSelfHostedCatalogue && this.selfHostedConfig) {
      const { default: axios } = await import("axios");
      return axios
        .get<T>(`${this.selfHostedConfig.url}${url}`, {
          params,
          timeout: 10000,
        })
        .then((r) => r.data);
    }
    return this.officialInstance
      .get<T>(url, { headers: this.officialAuthHeaders(), params })
      .then((r) => r.data);
  }

  private static selfHostedHeaders() {
    const token =
      this.selfHostedConfig!.userToken ?? this.selfHostedConfig!.masterToken;
    return { Authorization: `Bearer ${token}` };
  }

  public static async gameDataGet<T = any>(
    url: string,
    params?: any,
    flag = true
  ): Promise<T> {
    if (flag && this.selfHostedConfig) {
      const { default: axios } = await import("axios");
      return axios
        .get<T>(`${this.selfHostedConfig.url}${url}`, {
          params,
          timeout: 10000,
          headers: this.selfHostedHeaders(),
        })
        .then((r) => r.data);
    }
    return this.officialInstance
      .get<T>(url, { headers: this.officialAuthHeaders(), params })
      .then((r) => r.data);
  }

  public static async gameDataPost<T = any>(
    url: string,
    data?: any,
    flag = true
  ): Promise<T> {
    if (flag && this.selfHostedConfig) {
      const { default: axios } = await import("axios");
      return axios
        .post<T>(`${this.selfHostedConfig.url}${url}`, data, {
          timeout: 10000,
          headers: this.selfHostedHeaders(),
        })
        .then((r) => r.data);
    }
    return this.postOfficial<T>(url, data);
  }

  public static async gameDataPut<T = any>(
    url: string,
    data?: any,
    flag = true
  ): Promise<T> {
    if (flag && this.selfHostedConfig) {
      const { default: axios } = await import("axios");
      return axios
        .put<T>(`${this.selfHostedConfig.url}${url}`, data, {
          timeout: 10000,
          headers: this.selfHostedHeaders(),
        })
        .then((r) => r.data);
    }
    return this.officialInstance
      .put<T>(url, data, { headers: this.officialAuthHeaders() })
      .then((r) => r.data);
  }

  public static async gameDataDelete<T = any>(
    url: string,
    flag = true
  ): Promise<T> {
    if (flag && this.selfHostedConfig) {
      const { default: axios } = await import("axios");
      return axios
        .delete<T>(`${this.selfHostedConfig.url}${url}`, {
          timeout: 10000,
          headers: this.selfHostedHeaders(),
        })
        .then((r) => r.data);
    }
    return this.officialInstance
      .delete<T>(url, { headers: this.officialAuthHeaders() })
      .then((r) => r.data);
  }

  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private static isSocialUrl(url: string): boolean {
    return /^\/(profile\/blocks|features|badges|profile\/notifications)/.test(
      url
    );
  }

  private static isOfficialOnlyUrl(url: string) {
    // Download sources: route to self-hosted if toggle is on
    if (
      this.useSelfHostedDownloadSources &&
      url.startsWith("/download-sources")
    ) {
      return false;
    }
    if (this.OFFICIAL_ONLY_PREFIXES.some((prefix) => url.startsWith(prefix)))
      return true;
    if (this.OFFICIAL_ONLY_SUFFIXES.some((suffix) => url.includes(suffix)))
      return true;
    // /users/<id> — route to official if id is not a UUID (official uses short IDs)
    const usersMatch = url.match(/^\/users\/([^/?]+)/);
    if (usersMatch && !this.UUID_REGEX.test(usersMatch[1])) return true;
    return false;
  }

  private static getInstanceForUrl(url: string): AxiosInstance {
    // Without self-hosted the default instance already targets the official
    // API and carries the (token-redacting) log interceptors.
    if (!this.selfHostedConfig) return this.instance;

    if (!this.isOfficialOnlyUrl(url)) {
      // Social URLs: route to official if toggle is off
      if (this.isSocialUrl(url) && !this.useSelfHostedSocial) {
        return this.officialInstance ?? this.instance;
      }
      return this.instance;
    }
    return this.officialInstance ?? this.instance;
  }

  private static secondsToMilliseconds(seconds: number) {
    return seconds * 1000;
  }

  private static userAuth: HydraApiUserAuth = {
    authToken: "",
    refreshToken: "",
    expirationTimestamp: 0,
    subscription: null,
  };

  public static isLoggedIn() {
    return this.userAuth.authToken !== "";
  }

  public static hasActiveSubscription() {
    if (this.selfHostedConfig) return true;
    const expiresAt = new Date(this.userAuth.subscription?.expiresAt ?? 0);
    return expiresAt > new Date();
  }

  public static updateUserSubscription(
    subscription?: { expiresAt: Date | string | null } | null,
    options?: { freshUserId?: string; triggerSouvenirSync?: boolean }
  ) {
    this.userAuth.subscription = subscription
      ? { expiresAt: subscription.expiresAt }
      : null;

    if (process.platform === "linux" && !this.hasActiveSubscription()) {
      void import("./linux-game-capture-session").then(
        ({ stopAllLinuxGameCaptureSessions }) => {
          if (!this.hasActiveSubscription()) {
            stopAllLinuxGameCaptureSessions();
          }
        }
      );
    }

    if (
      options?.triggerSouvenirSync !== false &&
      this.isLoggedIn() &&
      this.hasActiveSubscription()
    ) {
      void import("./achievements/grouped-souvenir-worker")
        .then(async ({ groupedSouvenirWorker }) => {
          if (
            options?.freshUserId &&
            this.getAuthContext()?.userId === options.freshUserId
          ) {
            await groupedSouvenirWorker.resumeAfterSubscriptionRefresh(
              options.freshUserId,
              subscription?.expiresAt ?? null
            );
            return;
          }
          await groupedSouvenirWorker.trigger();
        })
        .catch((error) =>
          logger.error(
            "Failed to resume grouped souvenir synchronization",
            error
          )
        );
    }
  }

  static async handleExternalAuth(uri: string) {
    const { payload } = url.parse(uri, true).query;

    const decodedBase64 = atob(payload as string);
    const jsonData = JSON.parse(decodedBase64);

    const { accessToken, expiresIn, refreshToken, workwondersJwt } = jsonData;

    const generation = this.authContexts.invalidate();
    clearGamesPlaytimeState();
    this.userAuth = {
      authToken: "",
      refreshToken: "",
      expirationTimestamp: 0,
      subscription: null,
    };

    const now = new Date();

    const tokenExpirationTimestamp =
      now.getTime() +
      this.secondsToMilliseconds(expiresIn) -
      this.EXPIRATION_OFFSET_IN_MS;

    await clearStaleEpicImports(
      null,
      () => generation === this.authContexts.generation
    );
    // When a self-hosted session is active, official sign-in must not wipe
    // remote ids — they map the self-hosted library (fork behavior).
    if (!this.selfHostedConfig) {
      await clearGamesRemoteIds(
        () => generation === this.authContexts.generation
      );
    }
    if (generation !== this.authContexts.generation) return;

    this.userAuth = {
      authToken: accessToken,
      refreshToken: refreshToken,
      expirationTimestamp: tokenExpirationTimestamp,
      subscription: null,
    };
    this.activateAuthContext(generation);
    await clearStaleEpicImports(
      this.getAuthContext(),
      () => generation === this.authContexts.generation
    );

    const { AchievementWatcherManager } = await import(
      "./achievements/achievement-watcher-manager"
    );
    if (generation !== this.authContexts.generation) return;
    AchievementWatcherManager.resetSessionState();

    logger.log(
      "Sign in received. Token expiration timestamp:",
      tokenExpirationTimestamp
    );

    await this.persistAuth(
      {
        accessToken,
        refreshToken,
        tokenExpirationTimestamp,
        workwondersJwt,
      },
      generation
    ).catch((error) => {
      if (generation === this.authContexts.generation) throw error;
    });
    if (generation !== this.authContexts.generation) return;

    await getUserData().then((userDetails) => {
      if (generation !== this.authContexts.generation) return;
      if (userDetails?.subscription) {
        this.updateUserSubscription({
          expiresAt: userDetails.subscription.expiresAt
            ? new Date(userDetails.subscription.expiresAt)
            : null,
        });
      }
    });
    if (generation !== this.authContexts.generation) return;

    const { groupedSouvenirWorker } = await import(
      "./achievements/grouped-souvenir-worker"
    );
    if (generation !== this.authContexts.generation) return;
    void groupedSouvenirWorker.trigger();

    const { startSteamSyncOnStartup } = await import(
      "./steam-integration/steam-startup-sync"
    );
    if (generation !== this.authContexts.generation) return;
    void startSteamSyncOnStartup();
    const { startEpicSyncOnStartup } = await import("./epic");
    if (generation !== this.authContexts.generation) return;
    void startEpicSyncOnStartup();

    if (WindowManager.mainWindow) {
      if (this.selfHostedConfig) {
        // Official login while self-hosted is active — just notify UI, don't disturb self-hosted sync
        WindowManager.mainWindow.webContents.send("on-official-signin");
      } else {
        WindowManager.mainWindow.webContents.send("on-signin");
        void uploadGamesBatch();

        SSEClient.close();
        SSEClient.connect();

        const { syncDownloadSourcesFromApi } = await import("./user");
        if (generation !== this.authContexts.generation) return;
        syncDownloadSourcesFromApi();
      }
    }
  }

  static async handleSignOut(cleanupUserData?: () => Promise<void>) {
    const generation = this.authContexts.invalidate();
    clearGamesPlaytimeState();
    this.userAuth = {
      authToken: "",
      refreshToken: "",
      expirationTimestamp: 0,
      subscription: null,
    };
    // A self-hosted session outlives the official one (fork)
    this.activateAuthContext(generation);

    await clearStaleEpicImports(
      null,
      () => generation === this.authContexts.generation
    );
    const persistence = this.clearPersistedAuth(cleanupUserData);
    try {
      const { AchievementWatcherManager } = await import(
        "./achievements/achievement-watcher-manager"
      );
      if (generation !== this.authContexts.generation) return;
      AchievementWatcherManager.resetSessionState();
      const { stopAllLinuxGameCaptureSessions } = await import(
        "./linux-game-capture-session"
      );
      if (generation !== this.authContexts.generation) return;
      stopAllLinuxGameCaptureSessions();
      const { groupedSouvenirWorker } = await import(
        "./achievements/grouped-souvenir-worker"
      );
      if (generation !== this.authContexts.generation) return;
      groupedSouvenirWorker.stop();

      const { resetSteamStartupSync } = await import(
        "./steam-integration/steam-startup-sync"
      );
      if (generation !== this.authContexts.generation) return;
      resetSteamStartupSync();

      await persistence;
      if (generation !== this.authContexts.generation) return;
      this.sendSignOutEvent();
      // Preserve the legacy unauthenticated call without reading a future
      // account's token after an asynchronous request-validation gap.
      this.instance
        .post(
          "/auth/logout",
          {},
          {
            headers: { Authorization: "Bearer " },
            timeout: this.AUTH_REFRESH_TIMEOUT_MS,
          }
        )
        .catch(() => {});
    } finally {
      await persistence;
    }
  }

  static async setupApi() {
    this.instance = axios.create({
      baseURL: import.meta.env.MAIN_VITE_API_URL,
      headers: { "User-Agent": `Hydra Launcher v${appVersion}` },
    });

    this.officialInstance = axios.create({
      baseURL: import.meta.env.MAIN_VITE_API_URL,
      headers: { "User-Agent": `Hydra Launcher v${appVersion}` },
    });

    if (this.ADD_LOG_INTERCEPTOR) {
      this.instance.interceptors.request.use(
        (request) => {
          logger.log(" ---- REQUEST -----");
          logger.log(
            request.method,
            request.url,
            sanitizeNetworkLogPayload({
              params: request.params ?? null,
              data: request.data ?? null,
            })
          );
          return request;
        },
        (error) => {
          logger.error("request error", summarizeNetworkError(error));
          return Promise.reject(error);
        }
      );
      this.instance.interceptors.response.use(
        (response) => {
          logger.log(" ---- RESPONSE -----");
          logger.log(
            response.status,
            response.config.method,
            response.config.url,
            response.config.logResponseBody === false
              ? summarizeNetworkLogPayload(response.data)
              : sanitizeNetworkLogPayload(response.data)
          );
          return response;
        },
        (error) => {
          logger.error(" ---- RESPONSE ERROR -----");
          const config = error.config ?? {};

          logger.error(
            config.method,
            config.baseURL,
            config.url,
            sanitizeNetworkLogPayload({
              headers: config.headers ?? null,
              data: config.data ?? null,
            })
          );
          if (error.response) {
            logger.error(
              "Response error:",
              error.response.status,
              sanitizeNetworkLogPayload(error.response.data)
            );

            return Promise.reject(error as Error);
          }

          if (error.request) {
            const errorData = error.toJSON();
            logger.error("Request error:", summarizeNetworkError(error));
            return Promise.reject(
              new Error(
                `Request failed with ${errorData.code} ${errorData.message}`
              )
            );
          }

          logger.error("Error", summarizeNetworkError(error));
          return Promise.reject(error as Error);
        }
      );
    }

    const result = await db.getMany<string>(
      [levelKeys.auth, levelKeys.user, levelKeys.userPreferences],
      { valueEncoding: "json" }
    );

    const userAuth = result.at(0) as Auth | undefined;
    const user = result.at(1) as User | undefined;
    const userPreferences = result.at(2) as
      | import("@types").UserPreferences
      | undefined;

    if (
      userPreferences?.selfHostedApiUrl &&
      userPreferences?.selfHostedApiToken
    ) {
      // Check if self-hosted session has expired
      const durationDays = userPreferences.selfHostedSessionDurationDays ?? 30;
      const issuedAt = userPreferences.selfHostedTokenIssuedAt ?? 0;
      const expired =
        durationDays > 0 &&
        issuedAt > 0 &&
        Date.now() - issuedAt > durationDays * 24 * 60 * 60 * 1000;

      this.setSelfHostedConfig(
        userPreferences.selfHostedApiUrl,
        userPreferences.selfHostedApiToken,
        expired ? null : userPreferences.selfHostedUserToken
      );
      this.useSelfHostedCatalogue =
        userPreferences.useSelfHostedCatalogue ?? false;
      this.useSelfHostedReviews = userPreferences.useSelfHostedReviews ?? false;
      this.useSelfHostedHltb = userPreferences.useSelfHostedHltb ?? false;
      this.useSelfHostedProtondb =
        userPreferences.useSelfHostedProtondb ?? false;
    }

    this.userAuth = {
      authToken: userAuth?.accessToken ?? "",
      refreshToken: userAuth?.refreshToken ?? "",
      expirationTimestamp: userAuth?.tokenExpirationTimestamp ?? 0,
      subscription: user?.subscription
        ? { expiresAt: user.subscription?.expiresAt }
        : null,
    };
    const generation = this.authContexts.invalidate();
    clearGamesPlaytimeState();
    this.activateAuthContext(generation);
    await clearStaleEpicImports(
      this.getAuthContext(),
      () => generation === this.authContexts.generation
    );

    if (!this.selfHostedConfig) {
      const updatedUserData = await getUserData();
      if (generation !== this.authContexts.generation) return;
      this.updateUserSubscription(updatedUserData?.subscription);
    } else if (this.selfHostedConfig.userToken) {
      // Self-hosted with userToken — sync library on startup
      const { uploadGamesBatch } = await import("./library-sync");
      await clearGamesRemoteIds(
        () => generation === this.authContexts.generation
      );
      if (generation !== this.authContexts.generation) return;
      void uploadGamesBatch();
    }
  }

  private static sendSignOutEvent() {
    FriendsSnapshotCache.clear();
    ChatUnreadStore.clear();
    clearChatSenderProfiles();
    closeChatNotifications();
    // Covers the 401 path too, which never goes through the sign-out event.
    WindowManager.closeFriendsWindow();
    WindowManager.closeChatWindow();
    WindowManager.sendToAppWindows("on-signout");
  }

  public static async refreshToken() {
    const generation = this.authContexts.generation;
    if (!this.isLoggedIn()) throw new UserNotLoggedInError();
    if (this.refreshInFlight?.generation === generation) {
      return this.refreshInFlight.promise;
    }
    const promise = this.performTokenRefresh(generation);
    this.refreshInFlight = { generation, promise };
    try {
      return await promise;
    } finally {
      if (this.refreshInFlight?.promise === promise)
        this.refreshInFlight = null;
    }
  }

  private static async performTokenRefresh(generation: number) {
    const previousAuth = this.userAuth;
    const response = await this.instance.post(
      `/auth/refresh`,
      {
        refreshToken: previousAuth.refreshToken,
      },
      { timeout: this.AUTH_REFRESH_TIMEOUT_MS }
    );
    this.assertAuthGeneration(generation);

    const { accessToken, expiresIn } = response.data;

    const tokenExpirationTimestamp =
      Date.now() +
      this.secondsToMilliseconds(expiresIn) -
      this.EXPIRATION_OFFSET_IN_MS;

    this.userAuth = {
      ...previousAuth,
      authToken: accessToken,
      expirationTimestamp: tokenExpirationTimestamp,
    };

    logger.log(
      "Token refreshed. New expiration:",
      this.userAuth.expirationTimestamp
    );

    await db
      .get<string, Auth>(levelKeys.auth, { valueEncoding: "json" })
      .then((auth) => {
        this.assertAuthGeneration(generation);
        return this.persistAuth(
          {
            ...auth,
            accessToken,
            tokenExpirationTimestamp,
          },
          generation
        );
      });

    return { accessToken, expiresIn };
  }

  private static async revalidateAccessTokenIfExpired(
    generation: number,
    options?: HydraApiOptions
  ) {
    if (this.userAuth.expirationTimestamp < Date.now()) {
      try {
        await waitForHydraAuthRefresh(this.refreshToken(), options ?? {});
      } catch (err) {
        await this.handleUnauthorizedError(err, generation);
      }
    }
  }

  private static getAxiosConfig(url?: string) {
    const isSocialOverride =
      url && this.isSocialUrl(url) && !this.useSelfHostedSocial;
    const useSelfHosted =
      this.selfHostedConfig &&
      url &&
      !this.isOfficialOnlyUrl(url) &&
      !isSocialOverride;
    if (useSelfHosted) {
      const token =
        this.selfHostedConfig!.userToken ?? this.selfHostedConfig!.masterToken;
      return { headers: { Authorization: `Bearer ${token}` } };
    }
    // Official request — use official token if available
    if (this.userAuth.authToken) {
      return {
        headers: { Authorization: `Bearer ${this.userAuth.authToken}` },
      };
    }
    return { headers: {} };
  }

  private static readonly handleUnauthorizedError = async (
    err: unknown,
    generation = this.authContexts.generation
  ) => {
    if (
      generation === this.authContexts.generation &&
      err instanceof AxiosError &&
      err.response?.status === 401
    ) {
      if (this.selfHostedConfig) throw err;

      logger.error(
        "401 - Current credentials:",
        sanitizeNetworkLogPayload({
          credentials: this.userAuth,
          response: err.response?.data,
        })
      );

      const signedOutGeneration = this.authContexts.invalidate();
      clearGamesPlaytimeState();
      this.userAuth = {
        authToken: "",
        expirationTimestamp: 0,
        refreshToken: "",
        subscription: null,
      };
      await clearStaleEpicImports(
        null,
        () => signedOutGeneration === this.authContexts.generation
      );
      const persistence = this.clearPersistedAuth();
      try {
        const { AchievementWatcherManager } = await import(
          "./achievements/achievement-watcher-manager"
        );
        if (signedOutGeneration !== this.authContexts.generation) throw err;
        AchievementWatcherManager.resetSessionState();

        const { stopAllLinuxGameCaptureSessions } = await import(
          "./linux-game-capture-session"
        );
        if (signedOutGeneration !== this.authContexts.generation) throw err;
        stopAllLinuxGameCaptureSessions();
        const { groupedSouvenirWorker } = await import(
          "./achievements/grouped-souvenir-worker"
        );
        if (signedOutGeneration !== this.authContexts.generation) throw err;
        groupedSouvenirWorker.stop();

        await persistence;
        if (signedOutGeneration !== this.authContexts.generation) throw err;
        SSEClient.close();
        this.sendSignOutEvent();
      } finally {
        await persistence;
      }
    }

    throw err;
  };

  private static async validateOptions(options?: HydraApiOptions) {
    const generation = this.authContexts.generation;
    const needsAuth = options?.needsAuth == undefined || options.needsAuth;
    const needsSubscription = options?.needsSubscription === true;

    // In self-hosted mode the self-hosted server does its own auth, and
    // official-only requests are best-effort (there may be no official JWT)
    if (this.selfHostedConfig) {
      if (
        options?.authContext &&
        !this.isAuthContextCurrent(options.authContext)
      ) {
        throw new UserNotLoggedInError();
      }
      return generation;
    }

    if (needsAuth) {
      if (!this.isLoggedIn()) throw new UserNotLoggedInError();
      if (
        options?.authContext &&
        !this.isAuthContextCurrent(options.authContext)
      ) {
        throw new UserNotLoggedInError();
      }
      await this.revalidateAccessTokenIfExpired(generation, options);
      this.assertAuthGeneration(generation);
    }

    if (needsSubscription && !this.hasActiveSubscription()) {
      await this.refreshUserSubscription();

      if (!this.hasActiveSubscription()) {
        throw new SubscriptionRequiredError();
      }
    }
    if (needsAuth) this.assertAuthGeneration(generation);
    return generation;
  }

  private static async refreshUserSubscription() {
    if (!this.isLoggedIn()) return;
    const generation = this.authContexts.generation;

    try {
      const userDetails = await getUserData();
      if (generation !== this.authContexts.generation) return;
      if (userDetails) this.updateUserSubscription(userDetails.subscription);
    } catch (err) {
      logger.error("Failed to refresh subscription state", err);
    }
  }

  private static assertRequestScope(
    options: HydraApiOptions | undefined,
    generation: number
  ) {
    if (options?.needsAuth !== false) this.assertAuthGeneration(generation);
    if (
      options?.authContext &&
      !this.isAuthContextCurrent(options.authContext)
    ) {
      throw new UserNotLoggedInError();
    }
  }

  private static requestConfig(
    options: HydraApiOptions | undefined,
    generation: number,
    url?: string
  ) {
    this.assertRequestScope(options, generation);
    return {
      ...this.getAxiosConfig(url),
      signal: options?.signal,
      timeout: options?.timeout,
      logResponseBody: options?.logResponseBody,
      ...(options?.validateStatus
        ? { validateStatus: options.validateStatus }
        : {}),
    };
  }

  private static requestError(
    err: unknown,
    options: HydraApiOptions | undefined,
    generation: number
  ) {
    if (options?.needsAuth === false) return Promise.reject(err);
    return this.handleUnauthorizedError(err, generation);
  }

  static async get<T = any>(
    url: string,
    params?: any,
    options?: HydraApiOptions
  ) {
    const generation = await this.validateOptions(options);
    const config = this.requestConfig(options, generation, url);
    return this.getInstanceForUrl(url)
      .get<T>(url, {
        ...config,
        params,
        headers: {
          ...config.headers,
          "Hydra-If-Modified-Since": options?.ifModifiedSince?.toUTCString(),
          "If-None-Match": options?.ifNoneMatch,
        },
      })
      .then((response) => {
        this.assertRequestScope(options, generation);
        return response.data;
      })
      .catch((err) => this.requestError(err, options, generation));
  }

  static async getResponse<T = any>(
    url: string,
    params?: any,
    options?: HydraApiOptions
  ) {
    const generation = await this.validateOptions(options);
    const config = this.requestConfig(options, generation, url);
    return this.getInstanceForUrl(url)
      .get<T>(url, {
        ...config,
        params,
        headers: {
          ...config.headers,
          "Hydra-If-Modified-Since": options?.ifModifiedSince?.toUTCString(),
          "If-None-Match": options?.ifNoneMatch,
        },
      })
      .then((response) => {
        this.assertRequestScope(options, generation);
        return {
          status: response.status,
          data: response.data,
          headers: response.headers,
        };
      })
      .catch((err) => this.requestError(err, options, generation));
  }

  static async post<T = any>(
    url: string,
    data?: any,
    options?: HydraApiOptions
  ) {
    const generation = await this.validateOptions(options);
    return this.getInstanceForUrl(url)
      .post<T>(url, data, this.requestConfig(options, generation, url))
      .then((response) => {
        this.assertRequestScope(options, generation);
        return response.data;
      })
      .catch((err) => this.requestError(err, options, generation));
  }

  static async postResponse<T = unknown>(
    url: string,
    data?: unknown,
    options?: HydraApiOptions
  ) {
    const generation = await this.validateOptions(options);
    return this.instance
      .post<T>(url, data, this.requestConfig(options, generation))
      .then((response) => {
        this.assertRequestScope(options, generation);
        return { status: response.status, data: response.data };
      })
      .catch((err) => this.requestError(err, options, generation));
  }

  static async put<T = any>(
    url: string,
    data?: any,
    options?: HydraApiOptions
  ) {
    const generation = await this.validateOptions(options);
    return this.getInstanceForUrl(url)
      .put<T>(url, data, this.requestConfig(options, generation, url))
      .then((response) => {
        this.assertRequestScope(options, generation);
        return response.data;
      })
      .catch((err) => this.requestError(err, options, generation));
  }

  static async patch<T = any>(
    url: string,
    data?: any,
    options?: HydraApiOptions
  ) {
    const generation = await this.validateOptions(options);
    return this.getInstanceForUrl(url)
      .patch<T>(url, data, this.requestConfig(options, generation, url))
      .then((response) => {
        this.assertRequestScope(options, generation);
        return response.data;
      })
      .catch((err) => this.requestError(err, options, generation));
  }

  static async delete<T = any>(url: string, options?: HydraApiOptions) {
    const generation = await this.validateOptions(options);
    return this.getInstanceForUrl(url)
      .delete<T>(url, this.requestConfig(options, generation, url))
      .then((response) => {
        this.assertRequestScope(options, generation);
        return response.data;
      })
      .catch((err) => this.requestError(err, options, generation));
  }

  static async checkDownloadSourcesChanges(
    downloadSourceIds: string[],
    games: Array<{ shop: string; objectId: string }>,
    since: string
  ) {
    logger.info("HydraApi.checkDownloadSourcesChanges called with:", {
      downloadSourceIds,
      gamesCount: games.length,
      since,
      isLoggedIn: this.isLoggedIn(),
    });

    try {
      const result = await this.post<
        Array<{
          shop: string;
          objectId: string;
          newDownloadOptionsCount: number;
          downloadSourceIds: string[];
        }>
      >(
        "/download-sources/changes",
        {
          downloadSourceIds,
          games,
          since,
        },
        { needsAuth: true }
      );

      logger.info(
        "HydraApi.checkDownloadSourcesChanges completed successfully:",
        result
      );
      return result;
    } catch (error) {
      logger.error("HydraApi.checkDownloadSourcesChanges failed:", error);
      throw error;
    }
  }
}
