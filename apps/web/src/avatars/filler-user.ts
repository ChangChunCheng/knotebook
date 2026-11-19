// Main bundle (small). Logout unmounts AppShell, so a ref there can't see a user switch: the last user lives here.

let lastUserId: string | undefined;
let onUserChange: (() => void) | null = null;

export function setFillerUserChangeHandler(handler: (() => void) | null): void {
  onUserChange = handler;
}

export function syncFillerUser(id: string | undefined): void {
  if (id === undefined) return;
  if (lastUserId !== undefined && lastUserId !== id) onUserChange?.();
  lastUserId = id;
}

export function resetFillerUser(): void {
  lastUserId = undefined;
}
