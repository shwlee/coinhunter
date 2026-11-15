namespace CoinHunter.Contracts;

public sealed record ApiRouteContract(
    string Method, string Path, string Access, int RequiredStage, string Input, string Output);

public static class ApiCatalog
{
    public static readonly ApiRouteContract[] Public =
    [
        new("GET", "/api/session", "public", 3, "none", "{user,mock,google,identities}"),
        new("GET", "/api/auth/google/start", "public", 3, "query: next", "302 + flow cookie"),
        new("GET", "/api/auth/google/callback", "oauth-flow", 3, "query: code,state,error", "302 + session cookie"),
        new("POST", "/api/auth/mock", "development", 3, "JSON: email", "{user}"),
        new("POST", "/api/auth/logout", "session", 3, "none", "{ok}"),
        new("GET", "/api/admin/users", "admin", 3, "none", "{users}"),
        new("PUT", "/api/admin/users/{id}", "admin", 3, "JSON: active,role,expectedActive,expectedRole", "user"),
        new("GET", "/api/algorithm-assistant/contract", "user", 5, "none", "versioned authoring contract"),
        new("GET", "/api/algorithms", "user", 5, "none", "{algorithms}"),
        new("POST", "/api/algorithms", "user", 5, "text/plain + query:name; legacy JSON", "201 algorithm metadata"),
        new("POST", "/api/algorithms/validate", "user", 5, "text/plain; legacy JSON:source", "200/400 diagnostic"),
        new("GET", "/api/algorithms/{id}", "owner", 5, "query:metadata=1", "metadata; legacy small JSON source"),
        new("PUT", "/api/algorithms/{id}", "owner", 5, "text/plain + query:name,revision; legacy JSON", "metadata or 409"),
        new("GET", "/api/algorithms/{id}/source", "owner", 5, "none", "text/plain + X-Coinhunter-Metadata"),
        new("GET", "/api/history", "user", 5, "none", "{history}"),
        new("GET", "/api/maps", "public", 5, "none", "{maps}"),
        new("GET", "/api/example", "public", 5, "none", "text/plain attachment"),
        new("GET", "/api/admin/maps/default-settings", "admin", 5, "none", "{settings,limits}"),
        new("POST", "/api/admin/maps/validate-array", "admin", 5, "JSON: source,columns,rows", "{map}"),
        new("POST", "/api/admin/maps/validate-json", "admin", 5, "map JSON", "{map}"),
        new("PUT", "/api/admin/maps/order", "admin", 5, "JSON: ids,expectedIds", "{ok}"),
        new("GET", "/api/admin/maps", "admin", 5, "query:includeSamples=1", "{maps}"),
        new("POST", "/api/admin/maps", "admin", 5, "draft JSON", "201 {map,state}"),
        new("POST", "/api/admin/maps/{id}/copy", "admin", 5, "JSON: name,sourceRevision", "201 {map,state}"),
        new("GET", "/api/admin/maps/{id}/settings", "admin", 5, "none", "{map,state,limits}"),
        new("PUT", "/api/admin/maps/{id}/settings", "admin", 5, "JSON: settings,expectedRevision", "{map,state,limits}"),
        new("GET", "/api/admin/maps/{id}/preview", "admin", 5, "query:revision", "{map}"),
        new("POST", "/api/admin/maps/{id}/publish", "admin", 5, "JSON: revision,expected", "{state}"),
        new("PUT", "/api/admin/maps/{id}/visibility", "admin", 5, "JSON: enabled,expected", "{state}"),
        new("GET", "/api/admin/maps/{id}/draft", "admin", 5, "none", "{map,state}"),
        new("PUT", "/api/admin/maps/{id}/draft", "admin", 5, "draft JSON + expectedRevision", "{map,state}"),
        new("POST", "/api/game/validate", "guest-or-user", 6, "text/plain", "200/400 diagnostic"),
        new("POST", "/api/matches", "guest-or-user", 6, "text/plain + X-Coinhunter-Options; legacy JSON", "201 {id}"),
        new("GET", "/api/matches/{id}", "match-owner", 6, "none", "{sequence,game,logs}"),
        new("GET", "/api/matches/{id}/events", "match-owner", 6, "SSE subscription", "event:snapshot; data:{sequence,game,logs}"),
        new("DELETE", "/api/matches/{id}", "match-owner", 6, "none", "{ok}"),
        new("GET", "/api/matches/{id}/recording", "match-owner", 7, "closed match", "application/x-ndjson stream")
    ];

    public static readonly ApiRouteContract[] Internal =
    [
        new("POST", "/internal/v1/matches", "service", 4, "ExecutionRequest + idempotent requestId", "202 ExecutionAccepted"),
        new("GET", "/internal/v1/matches/{id}", "service", 4, "optional afterSequence; update wait <= 1s", "execution state + latest snapshot"),
        new("POST", "/internal/v1/matches/{id}/start", "service", 4, "requestId", "ack; requires prepared"),
        new("POST", "/internal/v1/matches/{id}/stop", "service", 4, "ExecutionStop", "ack; idempotent"),
        new("GET", "/internal/v1/matches/{id}/events", "service", 6, "SSE subscription", "versioned execution stream"),
        new("POST", "/internal/v1/validations", "service", 4, "source reference + scope + requestId", "preflight result"),
        new("POST", "/internal/v1/results/{id}/ack", "service", 6, "ResultAcknowledgement", "ack; idempotent"),
        new("GET", "/internal/v1/matches/{id}/recording", "service", 7, "closed match", "application/x-ndjson stream")
    ];

    public static ApiRouteContract? Find(IEnumerable<ApiRouteContract> routes, string method, string path)
    {
        var parts = path.Split('/');
        return routes.FirstOrDefault(route => route.Method == method &&
            route.Path.Split('/') is var expected && expected.Length == parts.Length &&
            expected.Zip(parts).All(pair => pair.First == "{id}" ? pair.Second.Length > 0 : pair.First == pair.Second));
    }
}
