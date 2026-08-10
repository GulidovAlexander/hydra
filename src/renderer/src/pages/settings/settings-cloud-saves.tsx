import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, RadioField } from "@renderer/components";
import { useAppSelector, useToast } from "@renderer/hooks";
import { settingsContext } from "@renderer/context";

export function SettingsCloudSaves() {
  const { t } = useTranslation("settings");
  const { updateUserPreferences } = useContext(settingsContext);
  const { showSuccessToast, showErrorToast } = useToast();

  const userPreferences = useAppSelector(
    (state) => state.userPreferences.value
  );

  const [version, setVersion] = useState<"v1" | "v2">("v2");

  useEffect(() => {
    setVersion(userPreferences?.cloudSavesVersion ?? "v2");
  }, [userPreferences]);

  const handleSave = async () => {
    try {
      await updateUserPreferences({ cloudSavesVersion: version });
      showSuccessToast(t("changes_saved"));
    } catch {
      showErrorToast(t("try_again"));
    }
  };

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
          value="v2"
          checked={version === "v2"}
          onChange={() => setVersion("v2")}
        />
        <RadioField
          name="cloud-saves-version"
          label={t("cloud_saves_v1")}
          value="v1"
          checked={version === "v1"}
          onChange={() => setVersion("v1")}
        />
      </div>
      <div style={{ marginTop: "12px" }}>
        <Button type="button" onClick={handleSave} disabled={false}>
          {t("save_changes")}
        </Button>
      </div>
    </div>
  );
}
