import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ADMIN, loginAs } from "./helpers.js";

test("PAT: created in settings -> Bearer request without cookies works -> PATCH changes scope and tools/list follows (#239) -> immediately 401 after revoke", async ({
  page,
  browser,
  baseURL,
}) => {
  await loginAs(page, ADMIN.email, ADMIN.password);

  // Randomized: specs share one stack and a failed run deliberately leaves it up; a fixed name would collide in the row-name
  // lookup (getByRole("row", { name, exact: true })) on re-run, with a strict mode violation that buries the real regression message.
  const tokenName = `E2E script ${Date.now()}`;

  await page.goto("/settings/authorization");
  await page.getByRole("button", { name: "Create API token" }).click();
  // `getByLabel` defaults to a case-insensitive substring match, so keep exact: before #247, with the token and HandleSection
  // (aria-label "Username") on the same account page, the two names collided in a strict mode violation.
  await page.getByLabel("Name", { exact: true }).fill(tokenName);
  // #239/#247/#181: access is three switches (all off by default, `ScopeTogglesField`); turning on "Edit" means notes:read notes:write.
  // #181: the "Delete" switch is disabled while Edit is off and togglable once Edit is on (not turned on here, so the token stays read-write).
  const deleteSwitch = page.getByRole("switch", { name: "Move to trash (can be restored)", exact: true });
  await expect(deleteSwitch).toBeDisabled();
  await expect(deleteSwitch).not.toBeChecked();
  await page.getByRole("switch", { name: "Create and edit notes", exact: true }).click();
  await expect(deleteSwitch).toBeEnabled();
  await expect(deleteSwitch).not.toBeChecked();
  await page.getByRole("button", { name: "Create token" }).click();

  const tokenField = page.getByLabel("New API token", { exact: true });
  await expect(tokenField).toBeVisible();
  const token = await tokenField.inputValue();
  expect(token).toMatch(/^knb_/);
  await page.getByRole("button", { name: "Done" }).click();

  // A **context without cookies**: a browser context would get 200 through the session cookie, which gives this request no
  // discrimination against Bearer. try/finally as in 02: release on assertion failure, otherwise failed runs leave contexts
  // piling up in the same worker.
  const anonymous = await browser.newContext();
  try {
    const api = anonymous.request;
    const ok = await api.get(`${baseURL}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
    expect(ok.status()).toBe(200);
    const created = await api.post(`${baseURL}/api/notes`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: "E2E via token" },
    });
    expect(created.status()).toBe(201);

    // #239: PATCH /api/auth/tokens/:id changes scope -> the same token's tools/list changes on the very next request.
    // The settings page has no UI for changing permissions, so use page.request (shares the page's session cookie) to hit the cookie-only PATCH.
    // Reuse this PAT deliberately rather than creating another: `PAT_CREATE_LIMIT` (`http/rate-limit.ts`) is 10 per user per hour,
    //   kept in server process memory, and e2e always uses ADMIN; when a dirty stack is re-run the image is unchanged, so `up --build`
    //   in `stack:up` does not recreate the container and the count persists - each run creates one more and a few runs hit a 429
    //   false red (this file and 13 each create one per run, same as before #239).
    const listed = await page.request.get("/api/auth/tokens");
    expect(listed.status()).toBe(200);
    const { tokens } = (await listed.json()) as { tokens: { id: string; name: string; scope: string }[] };
    const mine = tokens.find(t => t.name === tokenName);
    expect(mine?.scope).toBe("notes:read notes:write");
    const id = mine!.id;
    const toolNames = async (): Promise<string[]> => {
      const res = await api.post(`${baseURL}/api/mcp`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { result: { tools: { name: string }[] } };
      return body.result.tools.map(t => t.name);
    };
    const setScope = async (scope: string): Promise<void> => {
      const res = await page.request.patch(`/api/auth/tokens/${id}`, { data: { scope } });
      expect(res.status()).toBe(200);
      expect(((await res.json()) as { scope: string }).scope).toBe(scope);
    };
    const before = await toolNames();
    // Control: a read-write credential does list the write tools; `move_note_to_group` is absent because notes:move is missing.
    // #181: `list_trash` is available to every credential; `delete_note` / `restore_note` are absent because notes:delete is missing.
    expect(before).toContain("copy_note");
    expect(before).toContain("list_trash");
    expect(before).not.toContain("move_note_to_group");
    expect(before).not.toContain("delete_note");
    expect(before).not.toContain("restore_note");
    // Folders: `list_folders` is available to every credential; `delete_folder`, like delete_note, needs notes:delete.
    expect(before).toContain("list_folders");
    expect(before).not.toContain("delete_folder");
    await setScope("notes:read notes:write notes:move");
    const withMove = await toolNames();
    expect(withMove).toContain("move_note_to_group");
    expect(withMove).not.toContain("delete_note");
    expect(withMove).not.toContain("delete_folder");
    // #181: read-write-delete: the three tools that need notes:delete (delete_note, restore_note, and delete_folder since folders were added) appear, and move does not (move and delete are independent).
    await setScope("notes:read notes:write notes:delete");
    const withDelete = await toolNames();
    expect(withDelete).toContain("delete_note");
    expect(withDelete).toContain("restore_note");
    expect(withDelete).toContain("list_trash");
    expect(withDelete).toContain("delete_folder");
    expect(withDelete).not.toContain("move_note_to_group");
    await setScope("notes:read notes:write");
    const after = await toolNames();
    expect(after).not.toContain("move_note_to_group");
    expect(after).not.toContain("delete_note");
    expect(after).not.toContain("restore_note");
    expect(after).not.toContain("delete_folder");
    expect(after).toContain("list_trash");
    expect(after).toContain("list_folders");

    // Revoke the row created in this run (the name is randomized, so leftovers from earlier runs never share it).
    const row = page.getByRole("row", { name: tokenName, exact: true });
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Revoke token" }).click();
    // Assert "the just-created entry is gone", not "the list is empty": the specs share one stack, and the admin account may
    // hold tokens left by earlier runs (on a dirty-stack re-run "empty" would be a false red).
    await expect(page.getByText(tokenName)).toHaveCount(0);

    const revoked = await api.get(`${baseURL}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
    expect(revoked.status()).toBe(401);
    // "Invalid credential" and "no credential" are two different challenges (RFC 6750 sec 3 vs 3.1); pin both
    expect(revoked.headers()["www-authenticate"]).toContain('error="invalid_token"');
    expect(revoked.headers()["www-authenticate"]).toContain("resource_metadata=");
  } finally {
    await anonymous.close();
    // Revocation must not depend on the assertions above succeeding: revoke even if something went red midway, or re-runs on a
    // dirty stack accumulate credentials (limit 20 per user).
    // On the normal path it was already revoked through the UI above, so nothing is touched if it is not found here; a cleanup
    // failure must not mask the original error.
    try {
      const listed = (await (await page.request.get("/api/auth/tokens")).json()) as { tokens: { id: string; name: string }[] };
      const left = listed.tokens.find(t => t.name === tokenName);
      if (left) await page.request.delete(`/api/auth/tokens/${left.id}`);
    } catch {
      // Ignored: cleanup is best-effort.
    }
  }
});

test("OAuth: unauthenticated authorize -> log in -> consent -> local callback receives the code -> exchanged token works", async ({
  page,
  browser,
  baseURL,
}) => {
  // The test plays the MCP client: a local callback server receives the code. Playwright and chromium share one network
  // namespace, so loopback is reachable.
  const received: URLSearchParams[] = [];
  // Accept only `/cb`: the browser may also fetch `/favicon.ico` etc. on the callback page, which would shift `received[n]`.
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/cb") received.push(url.searchParams);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });

  try {
    // listen(0): chromium blocks low ports like port 1, so always let the OS pick a random port.
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}/cb`;

    const anonymous = await browser.newContext();
    const api = anonymous.request;
    try {
      const registered = await api.post(`${baseURL}/oauth/register`, {
        data: { client_name: `E2E client ${Date.now()}`, redirect_uris: [redirectUri] },
      });
      expect(registered.status()).toBe(201);
      const { client_id: clientId } = await registered.json();

      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const state = `st-${Date.now()}`;
      // #239/#181: request four scopes (the MCP challenge is exactly these four) so the consent page shows three checkboxes.
      const authorizeUrlFor = (s: string): string =>
        `${baseURL}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource: `${baseURL}/api/mcp`,
          scope: "notes:read notes:write notes:move notes:delete",
          state: s,
        }).toString()}`;
      const authorizeUrl = authorizeUrlFor(state);

      // Arrive **unauthenticated**: the return-to from #131 should send us to the login page and back to the consent page.
      // Do not use `loginAs`: its first line does `page.goto("/login")`, which wipes `?next=`, and login would land on `/`.
      // Fill and submit the form **in place on this page**.
      await page.goto(authorizeUrl);
      await expect(page).toHaveURL(/\/login\?next=/);
      await page.locator("#login-email").fill(ADMIN.email);
      await page.locator("#login-password").fill(ADMIN.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/\/authorize\?req=/);

      await expect(page.getByText(`127.0.0.1:${port}`)).toBeVisible();
      // #239/#181: on a first grant all three boxes are unchecked by default, so pressing Allow directly yields only notes:read;
      // tick "Edit" and then Allow. The "Delete" box is disabled while Edit is unticked and tickable once it is (not ticked here, so the grant stays read-write).
      const edit = page.getByRole("checkbox", { name: "Create and edit notes" });
      const move = page.getByRole("checkbox", { name: "Move to groups (can't be undone)" });
      const del = page.getByRole("checkbox", { name: "Move to trash (can be restored)" });
      await expect(edit).not.toBeChecked();
      await expect(move).not.toBeChecked();
      await expect(del).not.toBeChecked();
      await expect(del).toBeDisabled();
      await edit.click();
      await expect(del).toBeEnabled();
      await expect(del).not.toBeChecked();
      await page.getByRole("button", { name: "Allow" }).click();

      await expect.poll(() => received.length).toBeGreaterThan(0);
      const callback = received[0]!;
      expect(callback.get("state")).toBe(state);
      expect(callback.get("iss")).toBe(baseURL);
      expect(callback.get("error")).toBeNull();
      const code = callback.get("code")!;
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const tokenRes = await api.post(`${baseURL}/oauth/token`, {
        form: {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: redirectUri,
          resource: `${baseURL}/api/mcp`,
        },
      });
      expect(tokenRes.status()).toBe(200);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.scope).toBe("notes:read notes:write");
      const token = tokenBody.access_token as string;

      const notes = await api.get(`${baseURL}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
      expect(notes.status()).toBe(200);

      await page.goto("/settings/authorization");
      await expect(page.getByRole("row", { name: /^E2E client \d+$/ }).first()).toBeVisible();

      // #239: authorize the same client again: the Edit box carries over the currently granted permission (checked by default)
      // and is labelled "Currently granted", while the move and delete boxes stay unchecked. Press Deny so no second credential
      // is left (the old credential is unaffected: deny does not touch api_tokens).
      const state2 = `st2-${Date.now()}`;
      await page.goto(authorizeUrlFor(state2));
      await expect(page).toHaveURL(/\/authorize\?req=/);
      await expect(edit).toBeChecked();
      await expect(move).not.toBeChecked();
      await expect(del).not.toBeChecked();
      await expect(page.getByText("Currently granted")).toHaveCount(1);
      await page.getByRole("button", { name: "Deny" }).click();
      await expect.poll(() => received.length).toBeGreaterThan(1);
      expect(received[1]!.get("state")).toBe(state2);
      expect(received[1]!.get("error")).toBe("access_denied");
    } finally {
      await anonymous.close();
    }
  } finally {
    // Without closing it there is an open handle and the worker does not exit.
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
