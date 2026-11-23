import { render, renderHook, type RenderOptions } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Client } from '@vault/query-core';
import { VizClientProvider } from '../src/viz-client-context';

export const withClient = (client: Client) =>
  ({ children }: { children: ReactNode }) => createElement(VizClientProvider, { client }, children);

export const renderViz = (ui: React.ReactElement, client: Client, opts?: RenderOptions) =>
  render(ui, { wrapper: withClient(client), ...opts });

export const renderVizHook = <T,>(cb: () => T, client: Client) =>
  renderHook(cb, { wrapper: withClient(client) });
