import type { ApiRequest, Route } from './types.ts';

/** Find the first route for the host, the method, and the path. Parameters are decoded. */
export function matchRoute(
  routes: readonly Route[],
  request: ApiRequest,
): { route: Route; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (!route.hosts.includes(request.host)) continue;
    if (!route.methods.includes(request.method)) continue;
    if (route.when && !route.when(request)) continue;
    const match = route.pattern.exec(request.path);
    if (!match) continue;
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(match.groups ?? {})) {
      try {
        params[key] = decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
    return { route, params };
  }
  return undefined;
}
