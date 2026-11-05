//! Tells which Kubernetes distribution a cluster runs.

use std::collections::BTreeMap;

/// Version suffixes and API groups name a distribution outright, so they come
/// before node labels and provider IDs.
pub fn detect_distribution(
    git_version: &str,
    node_labels: &[BTreeMap<String, String>],
    api_groups: &[String],
    provider_ids: &[String],
) -> String {
    let has_label = |prefix: &str| {
        node_labels
            .iter()
            .any(|labels| labels.keys().any(|key| key.starts_with(prefix)))
    };
    let name = if git_version.contains("+k3s") {
        "k3s"
    } else if git_version.contains("+rke2") {
        "rke2"
    } else if git_version.contains("-eks-") {
        "EKS"
    } else if git_version.contains("-gke.") {
        "GKE"
    } else if api_groups.iter().any(|g| g.ends_with(".openshift.io")) {
        "OpenShift"
    } else if has_label("kubernetes.azure.com/") {
        "AKS"
    } else if has_label("minikube.k8s.io/") {
        "minikube"
    } else if provider_ids.iter().any(|id| id.starts_with("kind://")) {
        "kind"
    } else {
        "Kubernetes"
    };
    name.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_distributions() {
        let none: Vec<BTreeMap<String, String>> = vec![];
        assert_eq!(detect_distribution("v1.30.1+k3s1", &none, &[], &[]), "k3s");
        assert_eq!(
            detect_distribution("v1.30.1+rke2r1", &none, &[], &[]),
            "rke2"
        );
        assert_eq!(
            detect_distribution("v1.30.1-eks-abc", &none, &[], &[]),
            "EKS"
        );
        assert_eq!(
            detect_distribution("v1.30.1-gke.100", &none, &[], &[]),
            "GKE"
        );
        assert_eq!(
            detect_distribution("v1.30.1", &none, &["route.openshift.io".into()], &[]),
            "OpenShift"
        );
        let labels = vec![BTreeMap::from([(
            "kubernetes.azure.com/cluster".to_string(),
            "x".to_string(),
        )])];
        assert_eq!(detect_distribution("v1.30.1", &labels, &[], &[]), "AKS");
        let labels = vec![BTreeMap::from([(
            "minikube.k8s.io/name".to_string(),
            "m".to_string(),
        )])];
        assert_eq!(
            detect_distribution("v1.30.1", &labels, &[], &[]),
            "minikube"
        );
        assert_eq!(
            detect_distribution("v1.30.1", &none, &[], &["kind://docker/x/y".to_string()]),
            "kind"
        );
        assert_eq!(
            detect_distribution("v1.30.1", &none, &[], &[]),
            "Kubernetes"
        );
    }
}
