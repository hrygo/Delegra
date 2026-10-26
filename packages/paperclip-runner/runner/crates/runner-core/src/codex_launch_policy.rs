use crate::local_runner::LocalRunnerError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub const POLICY_DRIVER: &str = "codex_app_server_launch_policy_v1";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilesystemEntry {
    pub path: String,
    pub access: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellEnvironmentPolicy {
    pub inherit: String,
    pub ignore_default_excludes: bool,
    pub include_only: Vec<String>,
    pub set: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexLaunchPolicy {
    pub schema: String,
    pub default_filesystem: Vec<FilesystemEntry>,
    pub planning_filesystem: Vec<FilesystemEntry>,
    pub network_access: bool,
    pub externally_sandboxed: bool,
    pub shell_environment_policy: ShellEnvironmentPolicy,
}

fn invalid() -> LocalRunnerError {
    LocalRunnerError::invalid("codex_launch_policy_invalid")
}
fn text(value: &str, max: usize) -> bool {
    value.len() <= max && !value.contains('\0')
}

impl CodexLaunchPolicy {
    pub fn validate(&self) -> Result<(), LocalRunnerError> {
        if self.schema != "paperclip.codex.launch-policy.v1"
            || serde_json::to_vec(self).map_err(|_| invalid())?.len() > 256 * 1024
        {
            return Err(invalid());
        }
        for (entries, workspace_access) in [
            (&self.default_filesystem, "write"),
            (&self.planning_filesystem, "read"),
        ] {
            if entries.len() > 1024 {
                return Err(invalid());
            }
            let mut previous: Option<&str> = None;
            for entry in entries {
                if !text(&entry.path, 4096)
                    || !matches!(entry.access.as_str(), "none" | "read" | "write")
                    || (!matches!(
                        entry.path.as_str(),
                        ":root" | ":minimal" | ":tmpdir" | ":workspace_roots"
                    ) && !Path::new(&entry.path).is_absolute())
                    || previous.is_some_and(|path| path >= entry.path.as_str())
                {
                    return Err(invalid());
                }
                previous = Some(&entry.path);
            }
            for (path, access) in [
                (":root", "none"),
                (":minimal", "read"),
                (":tmpdir", "none"),
                (":workspace_roots", workspace_access),
            ] {
                if !entries
                    .iter()
                    .any(|entry| entry.path == path && entry.access == access)
                {
                    return Err(invalid());
                }
            }
        }
        let shell = &self.shell_environment_policy;
        if !matches!(shell.inherit.as_str(), "all" | "none") || shell.include_only.len() > 256 {
            return Err(invalid());
        }
        let mut previous: Option<&str> = None;
        for key in &shell.include_only {
            let mut chars = key.chars();
            if !text(key, 256)
                || !chars
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
                || previous.is_some_and(|value| value >= key.as_str())
            {
                return Err(invalid());
            }
            previous = Some(key);
        }
        for (key, value) in &shell.set {
            if !matches!(
                key.as_str(),
                "PATH"
                    | "PATHEXT"
                    | "SystemRoot"
                    | "WINDIR"
                    | "LANG"
                    | "LC_ALL"
                    | "HOME"
                    | "ZDOTDIR"
                    | "BASH_ENV"
                    | "AGENT_HOME"
            ) || !shell.include_only.contains(key)
                || !text(value, 4096)
            {
                return Err(invalid());
            }
        }
        Ok(())
    }

    pub fn digest(&self) -> String {
        canonical_digest(&serde_json::to_value(self).expect("typed policy serializes"))
    }
    pub fn profiles(&self) -> [String; 3] {
        let digest = self.digest();
        let prefix = format!("paperclip-runner-policy-v1-{}", &digest[7..]);
        [
            format!("{prefix}-workspace-only"),
            format!("{prefix}-workspace-read-only"),
            format!("{prefix}-external-sandbox"),
        ]
    }
    pub fn permission(&self, read_only: bool) -> String {
        self.profiles()[if read_only {
            1
        } else if self.externally_sandboxed {
            2
        } else {
            0
        }]
        .clone()
    }
    pub fn config(&self) -> Value {
        let filesystem = |entries: &[FilesystemEntry]| -> Value {
            entries
                .iter()
                .map(|entry| {
                    (
                        entry.path.clone(),
                        if entry.path == ":workspace_roots" {
                            json!({".": entry.access})
                        } else {
                            json!(entry.access)
                        },
                    )
                })
                .collect::<serde_json::Map<_, _>>()
                .into()
        };
        let names = self.profiles();
        let mut profiles = serde_json::Map::new();
        for (name, rules) in [
            (&names[0], filesystem(&self.default_filesystem)),
            (&names[1], filesystem(&self.planning_filesystem)),
            (&names[2], json!({":root": "write"})),
        ] {
            profiles.insert(
                name.clone(),
                json!({"filesystem": rules, "network": {"enabled": self.network_access}}),
            );
        }
        json!({"default_permissions": self.permission(false), "permissions": profiles,
            "shell_environment_policy": {"inherit": self.shell_environment_policy.inherit,
                "ignore_default_excludes": self.shell_environment_policy.ignore_default_excludes,
                "include_only": self.shell_environment_policy.include_only, "set": self.shell_environment_policy.set}})
    }

    pub(crate) fn preflight(
        &self,
        cwd: &str,
        mut request: impl FnMut(&str, Value) -> Result<Value, LocalRunnerError>,
    ) -> Result<(), LocalRunnerError> {
        let names = self.profiles();
        let mut cursor: Option<String> = None;
        let mut seen = BTreeSet::new();
        for page in 0..32 {
            let mut params = json!({"cwd": cwd, "limit": 128});
            if let Some(cursor) = &cursor {
                params["cursor"] = json!(cursor);
            }
            let response = request("permissionProfile/list", params).map_err(|_| {
                LocalRunnerError::invalid("codex_launch_policy_preflight_unavailable")
            })?;
            let data = response["data"]
                .as_array()
                .filter(|data| data.len() <= 128)
                .ok_or_else(invalid)?;
            for profile in data {
                let id = profile["id"].as_str().ok_or_else(invalid)?;
                if names.iter().any(|name| name == id) {
                    return Err(LocalRunnerError::invalid(
                        "codex_launch_policy_profile_conflict",
                    ));
                }
            }
            match response.get("nextCursor").filter(|value| !value.is_null()) {
                None => break,
                Some(value) => {
                    let next = value
                        .as_str()
                        .filter(|s| !s.is_empty() && s.len() <= 4096)
                        .ok_or_else(invalid)?;
                    if page == 31 || !seen.insert(next.to_owned()) {
                        return Err(invalid());
                    }
                    cursor = Some(next.to_owned());
                }
            }
        }
        let response = request("config/read", json!({"cwd": cwd, "includeLayers": false}))
            .map_err(|_| LocalRunnerError::invalid("codex_launch_policy_preflight_unavailable"))?;
        let config = response["config"].as_object().ok_or_else(invalid)?;
        if let Some(shell) = config
            .get("shell_environment_policy")
            .filter(|v| !v.is_null())
        {
            let shell = shell.as_object().ok_or_else(invalid)?;
            if let Some(set) = shell.get("set").filter(|v| !v.is_null()) {
                let keys = set.as_object().ok_or_else(invalid)?.keys();
                if keys.into_iter().any(|key| {
                    self.shell_environment_policy.include_only.contains(key)
                        && !self.shell_environment_policy.set.contains_key(key)
                }) {
                    return Err(LocalRunnerError::invalid(
                        "codex_launch_policy_environment_conflict",
                    ));
                }
            }
        }
        Ok(())
    }
}

pub fn canonical_digest(value: &Value) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON serializes"))
    )
}
