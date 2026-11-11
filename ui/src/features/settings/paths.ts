/** The cluster's Overview, the index route of `cluster/:id`. */
export function overviewPath(clusterId: string): string {
  return `/cluster/${encodeURIComponent(clusterId)}`;
}

/** The cluster's Settings page, which opens whether or not the cluster is connected. */
export function settingsPath(clusterId: string): string {
  return `${overviewPath(clusterId)}/settings`;
}
