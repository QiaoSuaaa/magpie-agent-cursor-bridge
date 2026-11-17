// Magpie's agent sandbox only resolves modules beside agent.js and rejects
// node: builtins, so this file uses globals only — no imports.
//
// In Magpie's agent sandbox, `globalThis.process` is undefined. The agent
// system checks `agent.dir` to verify whether the target app is installed;
// if the path does not exist on disk, Magpie displays an error (e.g.
// "magpie 在 \Applications\Cursor.app 没有找到它") and hides the agent from
// the Agent list completely.
//
// Magpie natively expands a leading `~` across all platforms (Windows,
// macOS, Linux) to the user's home directory. Pointing `dir` and `config`
// to `~/.config/magpie-cursor-bridge` ensures the directory check always
// succeeds regardless of the OS, drive letter, or custom Cursor install path.

export const cursorDir = '~/.config/magpie-cursor-bridge';
export const connectionFile = '~/.config/magpie-cursor-bridge/connection.json';

