import type { GameAssetsOptions, GameShop, ShopAssets } from "@types";
import { registerEvent } from "../register-event";
import { fetchGameArtwork, HydraApi } from "@main/services";
import {
  gamesArtworkSelectionSublevel,
  gamesShopAssetsSublevel,
  levelKeys,
} from "@main/level";
import { composeAssetsWithArtwork } from "@shared";
import { resolveEpicDefaultArtwork } from "@main/services/game-artwork";

const LOCAL_CACHE_EXPIRATION = 1000 * 60 * 60 * 8; // 8 hours

const applyArtworkSelection = async <T extends ShopAssets | null>(
  gameKey: string,
  assets: T
): Promise<T> => {
  if (!assets) return assets;

  const selection = await gamesArtworkSelectionSublevel.get(gameKey);

  return composeAssetsWithArtwork(assets, selection);
};

const fallbackArtworkUrl = async (
  shop: GameShop,
  objectId: string,
  kind: "icons" | "logos" | "heroes"
): Promise<string | null> => {
  try {
    const page = await fetchGameArtwork(shop, objectId, kind);
    if (page.items.length > 0) {
      const item = page.items[0];
      return kind === "heroes" ? item.url : item.thumb;
    }
  } catch {
    /* non-fatal */
  }
  return null;
};

const emptyAssets = (
  shop: GameShop,
  objectId: string,
  title: string
): ShopAssets => ({
  objectId,
  shop,
  title,
  iconUrl: null,
  libraryHeroImageUrl: null,
  libraryImageUrl: null,
  logoImageUrl: null,
  logoPosition: null,
  coverImageUrl: null,
  downloadSources: [],
});

/* Fills missing artwork from the artwork provider (SteamGridDB on self-hosted) */
const withFallbackArtwork = async (
  shop: GameShop,
  objectId: string,
  assets: ShopAssets
): Promise<ShopAssets> => ({
  ...assets,
  iconUrl:
    assets.iconUrl ?? (await fallbackArtworkUrl(shop, objectId, "icons")),
  logoImageUrl:
    assets.logoImageUrl ?? (await fallbackArtworkUrl(shop, objectId, "logos")),
  libraryHeroImageUrl:
    assets.libraryHeroImageUrl ??
    (await fallbackArtworkUrl(shop, objectId, "heroes")),
});

export const getGameAssets = async (
  objectId: string,
  shop: GameShop,
  options?: GameAssetsOptions
) => {
  if (shop === "custom") {
    return null;
  }

  const gameKey = levelKeys.game(shop, objectId);
  const artworkIdentity = options?.artworkIdentity ?? { shop, objectId };
  const artworkKey = levelKeys.game(
    artworkIdentity.shop,
    artworkIdentity.objectId
  );
  const cachedAssets = await gamesShopAssetsSublevel.get(gameKey);

  if (
    !options?.forceFresh &&
    cachedAssets &&
    cachedAssets.updatedAt + LOCAL_CACHE_EXPIRATION > Date.now() &&
    cachedAssets.iconUrl
  ) {
    if (shop !== "epic") return applyArtworkSelection(artworkKey, cachedAssets);
    const resolved = await resolveEpicDefaultArtwork(
      cachedAssets,
      cachedAssets
    );
    await gamesShopAssetsSublevel.put(gameKey, {
      ...resolved,
      updatedAt: cachedAssets.updatedAt,
    });
    return applyArtworkSelection(artworkKey, resolved);
  }

  let assets = await HydraApi.get<ShopAssets | null>(
    `/games/${shop}/${objectId}/assets`,
    null,
    {
      needsAuth: false,
    }
  ).catch(() => null);

  if (!assets) {
    /* The API may not know this game (e.g. self-hosted): build what we can */
    const title = cachedAssets?.title ?? "";
    const minimalAssets = await withFallbackArtwork(
      shop,
      objectId,
      emptyAssets(shop, objectId, title)
    );
    const hasArtwork =
      minimalAssets.iconUrl ||
      minimalAssets.logoImageUrl ||
      minimalAssets.libraryHeroImageUrl;

    await gamesShopAssetsSublevel.put(gameKey, {
      ...minimalAssets,
      updatedAt: Date.now(),
    });

    return hasArtwork ? applyArtworkSelection(artworkKey, minimalAssets) : null;
  }

  if (shop === "epic")
    assets = await resolveEpicDefaultArtwork(
      assets,
      options?.forceFresh ? null : cachedAssets
    );

  assets = await withFallbackArtwork(shop, objectId, assets);

  const shouldPreserveTitle =
    !options?.forceFresh &&
    cachedAssets?.title &&
    cachedAssets.title !== assets.title;

  await gamesShopAssetsSublevel.put(gameKey, {
    ...assets,
    title: shouldPreserveTitle ? cachedAssets.title : assets.title,
    updatedAt: Date.now(),
  });

  return applyArtworkSelection(artworkKey, assets);
};

const getGameAssetsEvent = async (
  _event: Electron.IpcMainInvokeEvent,
  objectId: string,
  shop: GameShop,
  options?: GameAssetsOptions
) => getGameAssets(objectId, shop, options);

registerEvent("getGameAssets", getGameAssetsEvent);
