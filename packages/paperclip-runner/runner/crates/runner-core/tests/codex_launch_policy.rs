use paperclip_runner_core::codex_launch_policy::CodexLaunchPolicy;
use serde_json::Value;

#[test]
fn shared_unicode_policy_has_identical_namespace_and_canonical_bytes() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/codex-launch-policy-unicode.json"
    ))
    .unwrap();
    let policy: CodexLaunchPolicy = serde_json::from_value(fixture["policy"].clone()).unwrap();
    policy.validate().unwrap();
    assert_eq!(policy.digest(), fixture["digest"].as_str().unwrap());
    assert_eq!(
        serde_json::to_string(&serde_json::to_value(&policy).unwrap()).unwrap(),
        fixture["canonical"].as_str().unwrap()
    );
    let mut invalid = fixture["policy"].clone();
    invalid["model_provider"] = "forbidden".into();
    assert!(serde_json::from_value::<CodexLaunchPolicy>(invalid).is_err());
}
