import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

type RoleResponse = {
  id: string;
  role: "user" | "admin";
};

async function getCurrentRole(): Promise<RoleResponse> {
  const response = await fetch("/api/me", { credentials: "include" });
  if (!response.ok) throw new Error("Unable to load the current user role");
  return response.json() as Promise<RoleResponse>;
}

export function AdminGuard({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const roleQuery = useQuery({
    queryKey: ["current-user-role"],
    queryFn: getCurrentRole,
    enabled: isLoaded && isSignedIn === true,
  });

  if (!isLoaded || roleQuery.isLoading) {
    return <div className="flex min-h-[240px] items-center justify-center"><div className="w-56 space-y-3"><div className="skeleton-bar h-3 rounded bg-muted" /><div className="skeleton-bar h-10 rounded-xl bg-muted" /></div></div>;
  }

  if (roleQuery.isError || roleQuery.data?.role !== "admin") {
    return <div className="rounded-2xl border border-destructive/25 bg-destructive/5 p-10 text-center"><h1 className="text-xl font-bold">Admin access required</h1><p className="mt-2 text-sm text-muted-foreground">This page is restricted to administrator accounts.</p></div>;
  }

  return <>{children}</>;
}