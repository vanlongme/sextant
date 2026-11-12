//! The relationship graph of a cluster's resources (spec E §4): what owns, selects, routes to,
//! mounts, reads, runs as and claims what. One graph per cluster, read through the watch hub.

// The graph hub reads these. Until it exists, only their tests do.
#[allow(dead_code)]
mod kinds;
#[allow(dead_code)]
mod pod;
mod types;

pub use types::{GraphEdge, GraphEvent, GraphNamespaceCount, GraphNode, GraphRel, GraphStatus};
