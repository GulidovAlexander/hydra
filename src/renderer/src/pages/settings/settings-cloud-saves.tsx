import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { RadioField } from "@renderer/components";
import { useAppSelector } from "@renderer/hooks";
import { settingsContext } from "@renderer/context";

export function SettingsCloudSaves() {
  const { t } = useTranslation("settings");
  const { updateUserPreferences } = useContext(settingsContext);

  const userPreferences = useAppSelector(
    (state) => state.userPreferences.value
  );

  const version = userPreferences?.cloudSavesVersion ?? "v2";

  return (
    <div className="settings-context-panel__group">
      <h3>{t("cloud_saves")}</h3>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <RadioField
          name="cloud-saves-version"
          label={t("cloud_saves_v2")}
          checked={version === "v2"}
          onChange={() => updateUserPreferences({ cloudSavesVersion: "v2" })}
        />
        <RadioField
          name="cloud-saves-version"
          label={t("cloud_saves_v1")}
          checked={version === "v1"}
          onChange={() => updateUserPreferences({ cloudSavesVersion: "v1" })}
        />
      </div>
    </div>
  );
}
