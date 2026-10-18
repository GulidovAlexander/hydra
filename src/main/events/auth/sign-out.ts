import { registerEvent } from "../register-event";
import {
  DownloadManager,
  HydraApi,
  SSEClient,
  WindowManager,
  emulators,
  retroarch,
} from "@main/services";
import { clearGamesPlaytimeState } from "@main/services/game-running-state";
import {
  downloadLayoutStateSublevel,
  downloadsSublevel,
  gamesSublevel,
} from "@main/level";

const signOut = async (_event: Electron.IpcMainInvokeEvent) => {
  const isSelfHostedActive = HydraApi.isSelfHostedAuthenticated();
  SSEClient.close();

  /* Cancels any ongoing downloads */
  DownloadManager.cancelDownload();

  await HydraApi.handleSignOut(async () => {
    /* Removes all games being played */
    clearGamesPlaytimeState();

    /* Self-hosted keeps the local library; only the session is dropped */
    if (isSelfHostedActive) return;

    const results = await Promise.allSettled([
      gamesSublevel.clear(),
      downloadsSublevel.clear(),
      downloadLayoutStateSublevel.clear(),
      emulators.resetEmulatorScanData(),
      retroarch.resetRetroArchScanData(),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  });

  /* The friends and chat windows are only meaningful while signed in */
  if (!HydraApi.isLoggedIn()) {
    WindowManager.closeFriendsWindow();
    WindowManager.closeChatWindow();
  }
};

registerEvent("signOut", signOut);
