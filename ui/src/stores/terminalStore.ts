import { create } from "zustand";
import type { TerminalTab } from "../types";

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  counter: number;

  addTab: () => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  setPtyId: (tabId: string, ptyId: string) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  counter: 0,

  addTab: () => {
    const num = get().counter + 1;
    const tab: TerminalTab = {
      id: `tab-${num}`,
      label: `Terminal ${num}`,
      ptyId: null,
    };
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      counter: num,
    }));
    return tab.id;
  },

  closeTab: (id) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        // Activate the previous tab, or the first remaining, or null
        const idx = s.tabs.findIndex((t) => t.id === id);
        activeTabId =
          tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
      }
      return { tabs, activeTabId };
    });
  },

  setActiveTab: (id) => {
    set({ activeTabId: id });
  },

  setPtyId: (tabId, ptyId) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, ptyId } : t
      ),
    }));
  },
}));
