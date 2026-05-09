import { useState } from "react";

type SettingsState = {
  emailNotifications: boolean;
  darkMode: boolean;
  autoSave: boolean;
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsState>({
    emailNotifications: true,
    darkMode: false,
    autoSave: true,
  });

  const handleToggle = (key: keyof SettingsState) => {
    setSettings((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleSave = () => {
    // Persist settings via API or localStorage if needed
    console.log("Saved settings:", settings);
    alert("Settings saved successfully");
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-semibold mb-8">Settings</h1>

      <div className="space-y-6">
        <div className="flex items-center justify-between border-b pb-4">
          <div>
            <p className="font-medium">Email notifications</p>
            <p className="text-sm text-gray-600">
              Receive updates and system notifications by email.
            </p>
          </div>
          <input
            type="checkbox"
            checked={settings.emailNotifications}
            onChange={() => handleToggle("emailNotifications")}
            className="h-5 w-5"
          />
        </div>

        <div className="flex items-center justify-between border-b pb-4">
          <div>
            <p className="font-medium">Dark mode</p>
            <p className="text-sm text-gray-600">
              Enable dark theme across the application.
            </p>
          </div>
          <input
            type="checkbox"
            checked={settings.darkMode}
            onChange={() => handleToggle("darkMode")}
            className="h-5 w-5"
          />
        </div>

        <div className="flex items-center justify-between border-b pb-4">
          <div>
            <p className="font-medium">Auto-save</p>
            <p className="text-sm text-gray-600">
              Automatically save changes as you work.
            </p>
          </div>
          <input
            type="checkbox"
            checked={settings.autoSave}
            onChange={() => handleToggle("autoSave")}
            className="h-5 w-5"
          />
        </div>
      </div>

      <div className="mt-10">
        <button
          onClick={handleSave}
          className="rounded-lg bg-black px-6 py-3 text-sm font-medium text-white hover:bg-gray-800 transition"
        >
          Save settings
        </button>
      </div>
    </div>
  );
}