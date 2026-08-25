---
name: Generated query polling
description: Type constraint for adding polling or other custom React Query options to this workspace's generated API hooks.
---

When passing custom React Query options (such as `refetchInterval`) to an Orval-generated query hook, include that operation's generated `get…QueryKey()` result in `query.queryKey`.

**Why:** The generated hook's `UseQueryOptions` type currently makes `queryKey` required when a custom query options object is supplied, even though the implementation will provide a default.

**How to apply:** Import the matching generated query-key helper and include `queryKey: get…QueryKey()` alongside polling, freshness, retry, or window-focus options.