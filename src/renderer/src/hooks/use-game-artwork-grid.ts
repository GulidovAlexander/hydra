import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ArtworkAssetType,
  CatalogueGameIdentity,
  ArtworkItem,
  ArtworkKind,
  GameArtworkSelection,
  GameShop,
} from "@types";
import { isVideoArtworkUrl } from "./game-artwork-utils";

const ARTWORK_KIND_BY_TYPE: Record<ArtworkAssetType, ArtworkKind> = {
  grid: "grids",
  hero: "heroes",
  logo: "logos",
  icon: "icons",
};

export const getArtworkDisplaySource = (
  item: Pick<ArtworkItem, "url" | "thumb">
) => {
  const src = isVideoArtworkUrl(item.thumb) ? item.url : item.thumb;
  return { src, isVideo: isVideoArtworkUrl(src) };
};

const isIcoUrl = (url: string | null | undefined) =>
  !!url && /\.ico(\?.*)?$/i.test(url);

const MEDIA_PRELOAD_TIMEOUT_MS = 10_000;

export const getRenderableArtworkUrl = (
  item: ArtworkItem,
  assetType: ArtworkAssetType
) => {
  if (
    assetType === "icon" &&
    isIcoUrl(item.url) &&
    item.thumb &&
    !isVideoArtworkUrl(item.thumb)
  ) {
    return item.thumb;
  }

  return item.url;
};

const preloadArtworkMedia = (url: string) =>
  new Promise<void>((resolve) => {
    let cleanup = () => {};
    let settled = false;

    const settle = () => {
      if (settled) return;

      settled = true;
      globalThis.clearTimeout(timeoutId);
      cleanup();
      resolve();
    };

    const timeoutId = globalThis.setTimeout(settle, MEDIA_PRELOAD_TIMEOUT_MS);

    if (isVideoArtworkUrl(url)) {
      const video = globalThis.document.createElement("video");
      video.preload = "auto";
      video.muted = true;
      video.onloadeddata = settle;
      video.onerror = settle;
      cleanup = () => {
        video.onloadeddata = null;
        video.onerror = null;
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
      video.src = url;
      video.load();
      return;
    }

    const image = new Image();
    image.onload = settle;
    image.onerror = settle;
    cleanup = () => {
      image.onload = null;
      image.onerror = null;
    };
    image.src = url;
  });

interface UseGameArtworkGridOptions {
  shop: GameShop;
  objectId: string;
  lookupIdentity?: CatalogueGameIdentity;
  assetType: ArtworkAssetType;
  enabled: boolean;
  onChanged: () => Promise<void> | void;
  onError: () => void;
  onPicked?: () => void;
  onCleared?: () => void;
  steamGridDbMode?: "hydra" | "custom";
  isSelfHosted?: boolean;
  gameTitle?: string;
  steamAppId?: string | null;
}

const SGDB_TYPE_BY_ASSET: Record<ArtworkAssetType, "icon" | "logo" | "hero"> = {
  grid: "hero",
  hero: "hero",
  logo: "logo",
  icon: "icon",
};

const toArtworkItems = (
  results: { id: number; url: string; thumb: string }[]
): ArtworkItem[] =>
  results.map((item) => ({
    id: item.id,
    score: 0,
    url: item.url,
    thumb: item.thumb ?? item.url,
    width: 0,
    height: 0,
  }));

export function useGameArtworkGrid({
  shop,
  objectId,
  lookupIdentity,
  assetType,
  enabled,
  onChanged,
  onError,
  onPicked,
  onCleared,
  steamGridDbMode = "hydra",
  isSelfHosted = false,
  gameTitle,
  steamAppId,
}: UseGameArtworkGridOptions) {
  const lookupShop = lookupIdentity?.shop ?? shop;
  const lookupObjectId = lookupIdentity?.objectId ?? objectId;
  const [items, setItems] = useState<ArtworkItem[]>([]);
  const [selection, setSelection] = useState<GameArtworkSelection | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [isStale, setIsStale] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const [pendingId, setPendingId] = useState<number | null>(null);

  const pageRef = useRef(0);
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadSelection = useCallback(async () => {
    const record = await globalThis.window.electron.getGameArtworkSelection(
      shop,
      objectId
    );
    setSelection(record);
  }, [shop, objectId]);

  const useCustomSgdb = steamGridDbMode === "custom" || isSelfHosted;

  const loadFromSteamGridDb = useCallback(async (): Promise<boolean> => {
    if (!useCustomSgdb || !gameTitle) return false;

    try {
      const results = await globalThis.window.electron.searchSteamGridDb(
        gameTitle,
        SGDB_TYPE_BY_ASSET[assetType],
        steamAppId
      );
      setItems(toArtworkItems(results));
      setHasMore(false);
      setHasFailed(false);
      return true;
    } catch {
      return false;
    }
  }, [useCustomSgdb, gameTitle, assetType, steamAppId]);

  const loadPage = useCallback(
    async (page: number) => {
      if (loadingRef.current) return;

      const requestId = requestIdRef.current;
      loadingRef.current = true;
      setIsLoading(true);

      const finishLoading = () => {
        if (requestId === requestIdRef.current) {
          loadingRef.current = false;
          setIsLoading(false);
        }
      };

      if (useCustomSgdb) {
        const ok = await loadFromSteamGridDb();
        if (requestId === requestIdRef.current) {
          if (!ok) {
            setHasFailed(true);
            setHasMore(false);
            onError();
          }
          finishLoading();
        }
        return;
      }

      try {
        const result = await globalThis.window.electron.getGameArtwork(
          lookupShop,
          lookupObjectId,
          ARTWORK_KIND_BY_TYPE[assetType],
          page
        );

        if (requestId !== requestIdRef.current) return;

        if (!result) {
          setHasMore(false);
          finishLoading();
          return;
        }

        setItems((previous) => {
          const merged = new Map(previous.map((item) => [item.id, item]));
          result.items.forEach((item) => merged.set(item.id, item));
          return Array.from(merged.values());
        });

        setIsStale(result.cache === "stale");
        setHasMore(result.hasMore);
        setHasFailed(false);
        pageRef.current = page + 1;
      } catch {
        if (requestId !== requestIdRef.current) return;

        setHasFailed(true);
        setHasMore(false);
        onError();
      } finally {
        finishLoading();
      }
    },
    [
      lookupShop,
      lookupObjectId,
      assetType,
      onError,
      useCustomSgdb,
      loadFromSteamGridDb,
    ]
  );

  const reset = useCallback(() => {
    requestIdRef.current += 1;
    loadingRef.current = false;
    pageRef.current = 0;
    setItems([]);
    setHasMore(true);
    setIsStale(false);
    setHasFailed(false);
    setIsLoading(true);
  }, []);

  useEffect(() => {
    loadSelection().catch(() => {});
  }, [loadSelection]);

  useLayoutEffect(() => {
    reset();
  }, [shop, objectId, lookupShop, lookupObjectId, assetType, reset]);

  useEffect(() => {
    if (!enabled) return;

    loadPage(0).catch(() => {});
  }, [enabled, loadPage]);

  const loadNextPage = useCallback(() => {
    loadPage(pageRef.current).catch(() => {});
  }, [loadPage]);

  const reload = useCallback(() => {
    reset();
    loadPage(0).catch(() => {});
  }, [reset, loadPage]);

  const pick = useCallback(
    async (item: ArtworkItem) => {
      setPendingId(item.id);
      const renderableUrl = getRenderableArtworkUrl(item, assetType);
      try {
        await globalThis.window.electron.setGameArtworkSelection({
          shop,
          objectId,
          type: assetType,
          url: renderableUrl,
          artworkId: item.id,
        });
        await loadSelection();
        await onChanged();
        await preloadArtworkMedia(renderableUrl);
        onPicked?.();
      } catch {
        onError();
      } finally {
        setPendingId((currentId) => (currentId === item.id ? null : currentId));
      }
    },
    [shop, objectId, assetType, loadSelection, onChanged, onError, onPicked]
  );

  const clear = useCallback(async () => {
    try {
      await globalThis.window.electron.setGameArtworkSelection({
        shop,
        objectId,
        type: assetType,
        clear: true,
      });
      await loadSelection();
      await onChanged();
      onCleared?.();
    } catch {
      onError();
    }
  }, [shop, objectId, assetType, loadSelection, onChanged, onError, onCleared]);

  const currentArtworkId = selection?.selected?.[assetType]?.artworkId;

  return {
    items,
    currentArtworkId,
    isLoading,
    hasMore,
    isStale,
    hasFailed,
    pendingId,
    loadNextPage,
    reloadSelection: loadSelection,
    reload,
    pick,
    clear,
  };
}
