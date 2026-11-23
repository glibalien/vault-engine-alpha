// @vitest-environment jsdom
/**
 * TypeLockChip.test.tsx
 *
 * TDD tests for the TypeLockChip dropdown component.
 * Tests: renders locked type label; clicking opens the menu; clicking a type
 * calls onPick(type); clicking unlock calls onUnlock(); menu closed by default.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TypeLockChip } from "../src/TypeLockChip.js";

describe("TypeLockChip", () => {
  afterEach(() => cleanup());

  it("renders the locked type label when lockedType is provided", () => {
    render(
      <TypeLockChip
        lockedType="task"
        availableTypes={["task", "project"]}
        onPick={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /type lock/i }).textContent).toContain("task");
  });

  it("renders 'Mixed results' label when lockedType is null", () => {
    render(
      <TypeLockChip
        lockedType={null}
        availableTypes={["task", "project"]}
        onPick={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /type lock/i }).textContent).toContain(
      "Mixed results",
    );
  });

  it("menu is closed by default", () => {
    render(
      <TypeLockChip
        lockedType="task"
        availableTypes={["task", "project"]}
        onPick={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );
    // Menu items should not be visible before clicking
    expect(screen.queryByRole("menuitemradio", { name: "project" })).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("clicking the chip button opens the menu", () => {
    render(
      <TypeLockChip
        lockedType="task"
        availableTypes={["task", "project"]}
        onPick={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /type lock/i }));
    // Type items use role=menuitemradio; unlock stays role=menuitem (action, not checked state)
    expect(screen.getByRole("menuitemradio", { name: "task" })).toBeDefined();
    expect(screen.getByRole("menuitemradio", { name: "project" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /unlock/i })).toBeDefined();
    // Locked type is aria-checked=true; others are false
    expect(screen.getByRole("menuitemradio", { name: "task" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "project" }).getAttribute("aria-checked")).toBe("false");
  });

  it("clicking a type item calls onPick with that type", () => {
    const onPick = vi.fn();
    render(
      <TypeLockChip
        lockedType="task"
        availableTypes={["task", "project"]}
        onPick={onPick}
        onUnlock={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /type lock/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "project" }));
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick).toHaveBeenCalledWith("project");
  });

  it("clicking the unlock option calls onUnlock", () => {
    const onUnlock = vi.fn();
    render(
      <TypeLockChip
        lockedType="task"
        availableTypes={["task", "project"]}
        onPick={vi.fn()}
        onUnlock={onUnlock}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /type lock/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /unlock/i }));
    expect(onUnlock).toHaveBeenCalledOnce();
  });

  it("clicking the chip again closes the menu (toggle)", () => {
    render(
      <TypeLockChip
        lockedType="task"
        availableTypes={["task", "project"]}
        onPick={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );
    const chip = screen.getByRole("button", { name: /type lock/i });
    fireEvent.click(chip);
    expect(screen.getByRole("menuitemradio", { name: "project" })).toBeDefined();
    fireEvent.click(chip);
    expect(screen.queryByRole("menuitemradio", { name: "project" })).toBeNull();
  });

  it("includes the locked type in the menu when availableTypes is non-empty", () => {
    render(
      <TypeLockChip
        lockedType="task"
        availableTypes={["project", "note"]}
        onPick={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /type lock/i }));
    // Locked type should appear in menu even if not in availableTypes
    expect(screen.getByRole("menuitemradio", { name: "task" })).toBeDefined();
    expect(screen.getByRole("menuitemradio", { name: "project" })).toBeDefined();
    expect(screen.getByRole("menuitemradio", { name: "note" })).toBeDefined();
  });

  it("shows only the locked type in the menu when availableTypes is empty", () => {
    render(
      <TypeLockChip
        lockedType="task"
        availableTypes={[]}
        onPick={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /type lock/i }));
    expect(screen.getByRole("menuitemradio", { name: "task" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /unlock/i })).toBeDefined();
  });

  it("clicking outside the open menu closes it", () => {
    render(
      <TypeLockChip
        lockedType="task"
        availableTypes={["task", "project"]}
        onPick={vi.fn()}
        onUnlock={vi.fn()}
      />,
    );
    // Open the menu
    fireEvent.click(screen.getByRole("button", { name: /type lock/i }));
    expect(screen.getByRole("menu")).toBeDefined();

    // Click outside (document.body is outside the component)
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
