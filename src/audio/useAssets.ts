import { useEffect, useState } from 'react';
import { listAssets, onAssetsChanged, type StoredAsset } from './assets.ts';

/** Imported audio files, kept up to date. */
export function useAssets(): StoredAsset[] {
  const [assets, setAssets] = useState<StoredAsset[]>([]);
  useEffect(() => {
    let alive = true;
    void listAssets().then((a) => alive && setAssets(a));
    const off = onAssetsChanged((a) => setAssets([...a]));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return assets;
}
