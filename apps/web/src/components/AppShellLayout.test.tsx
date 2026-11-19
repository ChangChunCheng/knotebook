import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useContext, useMemo, useRef, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { BlockAnchorContext, type BlockAnchorApi } from "@/hooks/block-anchor-context";
import { useNotePageControls, type NotePageControls } from "@/lib/note-page-controls";
import { useRegisterNotePage } from "@/lib/note-page-bridge";
import { useAppShellInert } from "@/lib/app-shell-inert";
import { AppShellLayout } from "./AppShellLayout";

// The shell itself isn't tested here: replaced by a stand-in that renders only children, to look at the context and inert the layout provides to the sidebar.
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children, inert }: { children: ReactNode; inert?: boolean }) => (
    <div data-testid="shell" data-inert={String(inert === true)}>
      {children}
    </div>
  ),
}));

function SidebarProbe() {
  const controls = useNotePageControls();
  const anchors = useContext(BlockAnchorContext);
  return <p data-testid="probe">{`${controls?.noteId ?? "none"}|${anchors.currentNoteId ?? "none"}`}</p>;
}

function Page() {
  const leavingRef = useRef(false);
  const controls = useMemo<NotePageControls>(
    () => ({ noteId: "note-1", state: { phase: "connecting" } as NotePageControls["state"], leavingRef, openEdits: () => {} }),
    [],
  );
  const anchors = useMemo<BlockAnchorApi>(() => ({ currentNoteId: "note-1", requestAnchor: () => {}, scrollToTop: () => {} }), []);
  useRegisterNotePage(controls, anchors);
  useAppShellInert(true);
  return <p>page</p>;
}

function GoHome() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate("/")}>
      go-home
    </button>
  );
}

describe("AppShellLayout", () => {
  it("page-registered controls, anchor API and inert reach consumers under the shell (the sidebar); unmounting the page clears them", async () => {
    render(
      <MemoryRouter initialEntries={["/n"]}>
        <Routes>
          <Route element={<AppShellLayout />}>
            <Route
              path="/n"
              element={
                <>
                  <Page />
                  <SidebarProbe />
                </>
              }
            />
            <Route path="/" element={<SidebarProbe />} />
          </Route>
        </Routes>
        <GoHome />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("note-1|note-1");
    expect(screen.getByTestId("shell")).toHaveAttribute("data-inert", "true");

    fireEvent.click(screen.getByRole("button", { name: "go-home" }));
    expect(await screen.findByText("none|none")).toBeInTheDocument();
    expect(screen.getByTestId("shell")).toHaveAttribute("data-inert", "false");
  });
});
