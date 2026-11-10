//! Metrics (F16) against the fake API server: the setting, detection, Prometheus behind the
//! service proxy, and metrics.k8s.io snapshots.

mod support;

use skopos_core::app_core::AppCore;
use skopos_core::error::{CoreResult, ErrorCode};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::metrics::{MetricsProviderSetting, PrometheusScheme};
use skopos_fakekube::FakeKubeConfig;
use support::connected_fake;

fn save_provider(
    core: &AppCore,
    id: &ClusterId,
    setting: MetricsProviderSetting,
) -> CoreResult<()> {
    let mut settings = core.cluster_settings_get(id);
    settings.metrics_provider = setting;
    core.cluster_settings_set(id, settings)
}

#[tokio::test]
async fn a_pinned_prometheus_is_saved_tidied_and_a_bad_one_is_refused() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let pinned = |prefix: Option<&str>| MetricsProviderSetting::Prometheus {
        namespace: "monitoring".to_owned(),
        service: "prom".to_owned(),
        port: 9090,
        scheme: Some(PrometheusScheme::Https),
        path_prefix: prefix.map(str::to_owned),
    };
    save_provider(&core, &id, pinned(Some(" /prometheus/ "))).unwrap();
    assert_eq!(
        core.cluster_settings_get(&id).metrics_provider,
        pinned(Some("/prometheus"))
    );
    let err = save_provider(&core, &id, pinned(Some("prometheus"))).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    // A refused setting leaves the saved one.
    assert_eq!(
        core.cluster_settings_get(&id).metrics_provider,
        pinned(Some("/prometheus"))
    );
}
