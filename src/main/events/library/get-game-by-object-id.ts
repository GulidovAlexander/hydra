import { registerEvent } from "../register-event";
import {
  gamesSublevel,
  downloadsSublevel,
  gameAchievementsSublevel,
  levelKeys,
} from "@main/level";
import type { GameShop } from "@types";
import { lookupCachedPlatform } from "./get-library";

const getGameByObjectId = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  const gameKey = levelKeys.game(shop, objectId);
  const [game, download, achievements] = await Promise.all([
    gamesSublevel.get(gameKey),
    downloadsSublevel.get(gameKey),
    gameAchievementsSublevel.get(gameKey).catch(() => null),
  ]);

  if (!game || game.isDeleted) return null;

  if (game.shop === "launchbox" && !game.platform) {
    const cachedPlatform = await lookupCachedPlatform(gameKey);
    if (cachedPlatform) {
      game.platform = cachedPlatform;
      gamesSublevel.put(gameKey, game).catch(() => {});
    }
  }

  const validAchievementNames = new Set(
    achievements?.achievements?.map((a) => (a.name ?? "").toUpperCase()) || []
  );

  const unlockedAchievementCount =
    achievements?.unlockedAchievements?.filter(
      (unlocked) =>
        validAchievementNames.has((unlocked.name ?? "").toUpperCase()) &&
        unlocked.unlockTime > 0
    ).length ??
    game.unlockedAchievementCount ??
    0;

  return { ...game, id: gameKey, download, unlockedAchievementCount };
};

registerEvent("getGameByObjectId", getGameByObjectId);
