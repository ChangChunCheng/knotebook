import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { SidebarQueryProvider, useSidebarQuery } from "./sidebar-query";

describe("SidebarQueryProvider (#369)", () => {
  let api!: ReturnType<typeof useSidebarQuery>;
  function Probe({ tag }: { tag: string }) {
    api = useSidebarQuery();
    return <span data-testid={tag}>{api.query}</span>;
  }

  it("the search text survives a shell swap (old Probe unmounts, new one mounts); without a provider it falls back to local state", () => {
    const view = render(
      <SidebarQueryProvider>
        <Probe tag="a" />
      </SidebarQueryProvider>,
    );
    act(() => api.setQuery("needle"));
    view.rerender(
      <SidebarQueryProvider>
        <Probe tag="b" />
      </SidebarQueryProvider>,
    );
    expect(view.getByTestId("b").textContent).toBe("needle");
    view.unmount();

    const solo = render(<Probe tag="c" />);
    act(() => api.setQuery("x"));
    expect(solo.getByTestId("c").textContent).toBe("x");
    solo.unmount();
    expect(render(<Probe tag="d" />).getByTestId("d").textContent).toBe("");
  });

  it("claim: the same owner does not clear, a different owner does; release (sign-out) clears and drops the owner", () => {
    const view = render(
      <SidebarQueryProvider>
        <Probe tag="a" />
      </SidebarQueryProvider>,
    );
    act(() => api.claim("u1"));
    act(() => api.setQuery("needle"));
    act(() => api.claim("u1"));
    expect(view.getByTestId("a").textContent).toBe("needle");
    act(() => api.claim("u2"));
    expect(view.getByTestId("a").textContent).toBe("");
    act(() => api.setQuery("again"));
    act(() => api.release());
    expect(view.getByTestId("a").textContent).toBe("");
  });
});
