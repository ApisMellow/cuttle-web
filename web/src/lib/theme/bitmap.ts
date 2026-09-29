// A-6 — builds a CardTheme from a loaded bitmap manifest. Private to
// lib/theme/; `index.ts` owns the registry and the loading lifecycle.

import type { Component } from 'svelte';

import BitmapCardBack from './BitmapCardBack.svelte';
import BitmapCardFace from './BitmapCardFace.svelte';
import BitmapTable from './BitmapTable.svelte';
import type { BitmapAssets, BitmapThemeManifest } from './catalog';
import type { CardBackProps, CardFaceProps, CardTheme, TableProps } from './types';

type Props = Record<PropertyKey, unknown>;

/**
 * Returns a component that renders `Inner` with one extra prop, `assets`,
 * fixed. Svelte 5 components are plain functions of `(anchor, props)`, so
 * this forwards the caller's reactive props object untouched (a Proxy keeps
 * its getters live) and adds the theme's assets beside them. The app keeps
 * rendering `<theme.Face {card} {size} {state} />` against CardFaceProps.
 */
function withAssets<P extends object>(Inner: Component<P & { assets: BitmapAssets }>, assets: BitmapAssets): Component<P> {
  const inner = Inner as unknown as (anchor: unknown, props: Props) => unknown;
  const bound = (anchor: unknown, props: Props) =>
    inner(
      anchor,
      new Proxy(props, {
        get: (target, key, receiver) => (key === 'assets' ? assets : Reflect.get(target, key, receiver)),
        has: (target, key) => key === 'assets' || Reflect.has(target, key),
      }),
    );
  return bound as unknown as Component<P>;
}

export function bitmapTheme(manifest: BitmapThemeManifest, assets: BitmapAssets): CardTheme {
  return {
    id: manifest.id,
    label: manifest.label,
    Face: withAssets<CardFaceProps>(BitmapCardFace, assets),
    Back: withAssets<CardBackProps>(BitmapCardBack, assets),
    Table: withAssets<TableProps>(BitmapTable, assets),
    assetBytes: manifest.assetBytes,
    available: () => true,
    names: manifest.names,
  };
}
