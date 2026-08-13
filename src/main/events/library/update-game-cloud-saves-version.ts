import { gamesSublevel, levelKeys } from "@main/level";
import type { GameShop } from "@types";
import { registerEvent } from "../register-event";

const updateGameCloudSavesVersion = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  cloudSavesVersion: "v1" | "v2" | null
) => {
  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);

  if (!game) return;

  await gamesSublevel.put(gameKey, {
    ...game,
    cloudSavesVersion,
  });
};

registerEvent("updateGameCloudSavesVersion", updateGameCloudSavesVersion);
