//! The relationship graph of a cluster's resources (spec E §4): what owns, selects, routes to,
//! mounts, reads, runs as and claims what. One graph per cluster, read through the watch hub.

mod build;
mod extract;
mod hub;
mod kinds;
mod pod;
mod types;

pub(crate) use hub::GraphHub;
pub use types::{GraphEdge, GraphEvent, GraphNamespaceCount, GraphNode, GraphRel, GraphStatus};
