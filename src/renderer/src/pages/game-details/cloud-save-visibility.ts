import type { GameShop } from "@types";

export type CloudSaveUiMode = "legacy" | "v2";
export type LegacyCloudSavePurpose = "active" | "archive";
export type CloudSavesVersion = "v1" | "v2";

export interface CloudSaveSettingsVisibility {
  showV2: boolean;
  showLegacy: boolean;
  legacyPurpose: LegacyCloudSavePurpose;
}

export interface CloudSaveVisibility {
  hero: CloudSaveUiMode | null;
  settings: CloudSaveSettingsVisibility;
}

export const isLegacyCloudSaveSettingsAvailable = (
  settings: CloudSaveSettingsVisibility,
  hasActiveSubscription: boolean,
  artifactCount: number
): boolean =>
  settings.showLegacy &&
  (settings.legacyPurpose === "active" ||
    (hasActiveSubscription && artifactCount > 0));

export const getCloudSaveVisibility = (
  shop: GameShop,
  cloudSavesVersion: CloudSavesVersion = "v2",
  selfHosted = false
): CloudSaveVisibility => {
  if (shop === "steam") {
    if (cloudSavesVersion === "v1") {
      return {
        hero: "legacy",
        settings: {
          showV2: false,
          showLegacy: true,
          legacyPurpose: "active",
        },
      };
    }

    return {
      hero: "v2",
      settings: {
        showV2: true,
        showLegacy: !selfHosted,
        legacyPurpose: "archive",
      },
    };
  }

  if (shop === "launchbox") {
    return {
      hero: "legacy",
      settings: {
        showV2: false,
        showLegacy: true,
        legacyPurpose: "active",
      },
    };
  }

  return {
    hero: null,
    settings: {
      showV2: false,
      showLegacy: true,
      legacyPurpose: "active",
    },
  };
};
