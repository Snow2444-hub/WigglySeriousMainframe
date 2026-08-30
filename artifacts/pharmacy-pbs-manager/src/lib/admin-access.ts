export type AdminRole = "user" | "admin";

export function adminAccessForRole(role: AdminRole | null | undefined) {
  const isAdmin = role === "admin";
  return {
    canViewPage: isAdmin,
    showNavigationLink: isAdmin,
  };
}