import {
  Bounds,
  GoogleTms,
  ImageFormat,
  NamedBounds,
  Nztm2000QuadTms,
  TileMatrixSet,
  TileMatrixSets,
  VectorFormat,
} from '@basemaps/geo';
import { fsa } from '@chunkd/fs';
import { CogTiff } from '@cogeotiff/core';
import { Cotar } from '@cotar/core';
import PLimit from 'p-limit';
import { basename } from 'path';
import ulid from 'ulid';

import { ConfigId } from '../base.config.js';
import { sha256base58 } from '../base58.node.js';
import { parseRgba } from '../color.js';
import { BaseConfig } from '../config/base.js';
import { ConfigImagery, ConfigImageryOverview } from '../config/imagery.js';
import { ConfigPrefix } from '../config/prefix.js';
import { ConfigProvider } from '../config/provider.js';
import { ConfigLayer, ConfigTileSet, TileSetType } from '../config/tile.set.js';
import { ConfigVectorStyle, StyleJson } from '../config/vector.style.js';
import { ConfigBundled, ConfigProviderMemory } from '../memory/memory.config.js';
import { LogType } from './log.js';
import { zProviderConfig } from './parse.provider.js';
import { zStyleJson } from './parse.style.js';
import { TileSetConfigSchemaLayer, zTileSetConfig } from './parse.tile.set.js';
import { loadTiffsFromPaths } from './tiff.config.js';

const Q = PLimit(10);

export function guessIdFromUri(uri: string): string | null {
  const parts = uri.split('/');
  const id = uri.endsWith('/') ? parts.at(-2) : parts.at(-1);

  if (id == null) return null;
  try {
    const date = new Date(ulid.decodeTime(id));
    if (date.getUTCFullYear() < 2015) return null;
    if (date.getUTCFullYear() > new Date().getUTCFullYear() + 1) return null;
    return id;
  } catch (e) {
    return null;
  }
}

/**
 * Check to see if this tiff has any data
 *
 * This looks at tiff tile offset arrays see if any internal tiff tiles contain any data
 *
 * @param toCheck Path or tiff check
 * @returns true if the tiff is empty, false otherwise
 */
export async function isEmptyTiff(toCheck: string | CogTiff): Promise<boolean> {
  const tiff = typeof toCheck === 'string' ? await CogTiff.create(fsa.source(toCheck)) : toCheck;

  // Starting the smallest tiff overview greatly reduces the amount of data needing to be read
  // if the tiff contains data.
  for (let i = tiff.images.length - 1; i >= 0; i--) {
    const tileOffsets = tiff.images[i].tileOffset;
    await tileOffsets.load();
    const offsets = tileOffsets.value ?? [];
    // If any tile offset is above 0 then there is data at that offset.
    for (const offset of offsets) {
      // There exists a tile that contains some data, so this tiff is not empty
      if (offset > 0) return false;
    }
  }
  return true;
}

export class ConfigJson {
  mem: ConfigProviderMemory;
  path: string;
  cache: Map<string, Promise<ConfigImagery>> = new Map();
  logger: LogType;

  constructor(path: string, log: LogType) {
    this.path = path;
    this.mem = new ConfigProviderMemory();
    this.logger = log;
  }

  /** Import configuration from a base path */
  static async fromPath(basePath: string, log: LogType): Promise<ConfigProviderMemory> {
    if (basePath.endsWith('.json') || basePath.endsWith('.json.gz')) {
      const config = await fsa.readJson<BaseConfig>(basePath);
      if (config.id && config.id.startsWith('cb_')) {
        // We have been given a config bundle just load that instead!
        return ConfigProviderMemory.fromJson(config as unknown as ConfigBundled);
      }
    }

    const cfg = new ConfigJson(basePath, log);

    const files = await fsa.toArray(fsa.list(basePath));

    const todo = files.map(async (filePath) => {
      if (!filePath.endsWith('.json')) return;
      const bc: BaseConfig = (await fsa.readJson(filePath)) as BaseConfig;
      const prefix = ConfigId.getPrefix(bc.id);
      if (prefix) {
        log.debug({ path: filePath, type: prefix, config: bc.id }, 'Config:Load');
        switch (prefix) {
          case ConfigPrefix.TileSet:
            cfg.mem.put(await cfg.tileSet(bc));
            break;
          case ConfigPrefix.Provider:
            cfg.mem.put(await cfg.provider(bc));
            break;
          case ConfigPrefix.Style:
            cfg.mem.put(await cfg.style(bc));
            break;
        }
      } else {
        log.warn({ path: filePath }, 'Config:Invalid');
      }
    });

    await Promise.all(todo);

    return cfg.mem;
  }

  async provider(obj: unknown): Promise<ConfigProvider> {
    const pv = zProviderConfig.parse(obj);
    this.logger.info({ config: pv.id }, 'Config:Loaded:Provider');

    return {
      id: pv.id,
      name: ConfigId.unprefix(ConfigPrefix.Provider, pv.id),
      serviceIdentification: pv.serviceIdentification,
      serviceProvider: pv.serviceProvider,
      updatedAt: Date.now(),
      version: 1,
    };
  }

  async style(obj: unknown): Promise<ConfigVectorStyle> {
    const st = zStyleJson.parse(obj);
    this.logger.info({ config: st.id }, 'Config:Loaded:Style');

    return {
      id: st.id,
      name: st.name,
      style: st as StyleJson,
      updatedAt: Date.now(),
    };
  }

  async tileSet(obj: unknown): Promise<ConfigTileSet> {
    const ts = zTileSetConfig.parse(obj);
    this.logger.info({ config: ts.id }, 'Config:Loaded:TileSet');

    const imageryFetch: Promise<ConfigImagery>[] = [];
    if (ts.type === TileSetType.Raster) {
      for (const layer of ts.layers) {
        if (layer[2193] != null) {
          imageryFetch.push(this.loadImagery(layer[2193], Nztm2000QuadTms, layer.name, layer.title));
        }

        if (layer[3857] != null) {
          imageryFetch.push(this.loadImagery(layer[3857], GoogleTms, layer.name, layer.title));
        }
      }
    }

    const imagery = await Promise.all(imageryFetch);

    const layers: ConfigLayer[] = [];
    const tileSet: Partial<ConfigTileSet> = {
      type: ts.type,
      id: ts.id,
      name: ConfigId.unprefix(ConfigPrefix.TileSet, ts.id),
      title: ts.title,
      layers,
    };
    function updateLayerUri(
      layer: TileSetConfigSchemaLayer,
      uri: string | undefined,
      logger: LogType,
    ): string | undefined {
      if (uri == null) return uri;
      if (uri.startsWith(ConfigPrefix.Imagery)) return uri;
      const record = imagery.find((f) => f.uri === uri); ///
      if (record == null) throw new Error('Unable to find imagery id for uri:' + uri);

      if (record.title && record.title !== layer.title) {
        logger.warn(
          { layer: layer.name, imageryTitle: record.title, layerTitle: layer.title },
          'Imagery:Title:Missmatch',
        );
      }
      record.title = layer.title;

      if (layer.category) {
        if (record.category && record.category !== layer.category) {
          logger.warn(
            { layer: layer.name, imageryCategory: record.category, layerCategory: layer.category },
            'Imagery:Category:Missmatch',
          );
        }
        record.category = layer.category;
      }

      return record.id;
    }

    // Map the configuration sources into imagery ids
    for (const l of ts.layers) {
      const layer = { ...l };
      layers.push(layer);

      if (tileSet.type === TileSetType.Raster) {
        if (layer[2193]) layer[2193] = updateLayerUri(layer, layer[2193], this.logger);
        if (layer[3857]) layer[3857] = updateLayerUri(layer, layer[3857], this.logger);
      }
    }
    if (ts.description) tileSet.description = ts.description;
    if (ts.category) tileSet.category = ts.category;
    if (ts.minZoom) tileSet.minZoom = ts.minZoom;
    if (ts.maxZoom) tileSet.maxZoom = ts.maxZoom;
    if (ts.background && tileSet.type === TileSetType.Raster) {
      tileSet.background = parseRgba(ts.background);
    }

    if (ts.format) {
      tileSet.format = ts.format as ImageFormat | VectorFormat;
    } else {
      tileSet.format = ts.type === TileSetType.Vector ? VectorFormat.MapboxVectorTiles : ImageFormat.Webp;
    }

    return tileSet as ConfigTileSet;
  }

  loadImagery(path: string, tileMatrix: TileMatrixSet, name: string, title: string): Promise<ConfigImagery> {
    let existing = this.cache.get(path);
    if (existing == null) {
      existing = this._loadImagery(path, tileMatrix, name, title);
      this.cache.set(path, existing);
    }
    return existing;
  }

  async _loadImagery(uri: string, tileMatrix: TileMatrixSet, name: string, title: string): Promise<ConfigImagery> {
    // TODO is there a better way of guessing the imagery id & tile matrix?
    const imageId = guessIdFromUri(uri) ?? sha256base58(uri);
    const id = ConfigId.prefix(ConfigPrefix.Imagery, imageId);
    this.logger.trace({ uri, imageId: id }, 'Imagery:Fetch');

    const fileList = await fsa.toArray(fsa.details(uri));
    const tiffFiles = fileList.filter((f) => f.path.endsWith('.tiff') || f.path.endsWith('.tif'));

    const tiffTiles = [];
    // Files can be stored as `{z}-{x}-{y}.tiff`
    // Check to see if all tiffs match the z-x-y format
    for (const tiff of tiffFiles) {
      const tileName = basename(tiff.path).replace('.tiff', '');
      const [z, x, y] = tileName.split('-').map((f) => Number(f));
      if (isNaN(x) || isNaN(y) || isNaN(z)) break;

      tiffTiles.push({ tiff, tile: { z, x, y } });
    }

    let bounds: Bounds | null = null;

    const imageList: NamedBounds[] = [];
    if (tiffTiles.length !== tiffFiles.length) {
      // some of the tiffs are not named `{z}-{x}-{y}.tiff` so extract bounds from the tiff
      const tiffs = await loadTiffsFromPaths(
        tiffFiles.map((m) => m.path),
        Q,
      );

      for (const tiff of tiffs) {
        const gsd = tiff.images[0].resolution[0];

        const gsdRound = Math.floor(gsd * 100) / 10000;
        const bbox = tiff.images[0].bbox.map((f) => Math.floor(f / gsdRound) * gsdRound);
        const imgBounds = Bounds.fromBbox(bbox);

        if (bounds == null) bounds = imgBounds;
        else bounds = bounds.union(imgBounds);

        const tileName = basename(tiff.source.uri);
        imageList.push({ ...imgBounds, name: tileName });
      }
    } else {
      for (const t of tiffTiles) {
        // TODO add the .tiff extension back in once the new basemaps-config workflow has been merged
        const tileName = basename(t.tiff.path).replace('.tiff', '');

        const tile = tileMatrix.tileToSourceBounds(t.tile);
        // Expand the total bounds to cover this tile
        if (bounds == null) bounds = Bounds.fromJson(tile);
        else bounds = bounds.union(Bounds.fromJson(tile));
        imageList.push({ ...tile, name: tileName });
      }
    }

    // Sort the files by Z, X, Y
    imageList.sort((a, b): number => {
      const widthSize = a.width - b.width;
      if (widthSize !== 0) return widthSize;

      const aXyz = a.name.split('-').map((f) => Number(f));
      const bXyz = b.name.split('-').map((f) => Number(f));

      const zDiff = aXyz[0] - bXyz[0];
      if (zDiff !== 0) return zDiff;

      const xDiff = aXyz[1] - bXyz[1];
      if (xDiff !== 0) return xDiff;

      return bXyz[2] - aXyz[2];
    });

    this.logger.debug({ uri, imageId, files: imageList.length }, 'Imagery:Fetch:Done');

    if (bounds == null) throw new Error('Failed to get bounds from URI: ' + uri);
    const now = Date.now();
    const output: ConfigImagery = {
      id,
      name,
      title,
      updatedAt: now,
      projection: tileMatrix.projection.code,
      tileMatrix: tileMatrix.identifier,
      uri,
      bounds,
      files: imageList,
    };

    output.overviews = await ConfigJson.findImageryOverviews(output);
    this.mem.put(output);
    // Ensure there is also a tile set for each imagery set
    // this.mem.put(ConfigJson.imageryToTileSet(output));
    return output;
  }

  static async findImageryOverviews(cfg: ConfigImagery): Promise<ConfigImageryOverview | undefined> {
    if (cfg.overviews) throw new Error('Overviews exist already for config: ' + cfg.id);

    const targetOverviews = fsa.join(cfg.uri, 'overviews.tar.co');
    const exists = await fsa.exists(targetOverviews);
    if (!exists) return;

    const tileMatrix = TileMatrixSets.find(cfg.tileMatrix);
    if (tileMatrix == null) throw new Error('Missing tileMatrix for imagery:' + cfg.id);

    const cotar = await Cotar.fromTar(fsa.source(targetOverviews));

    // When the cotars are made a WMTSCapabilties is added so it easy to view in something like QGIS
    // We can use the WMTSCapabitities to figure out the tileMatrix and zoom levels
    const wmtsRaw = await cotar.get('WMTSCapabilities.xml');
    if (wmtsRaw == null) return;

    const wmts = Buffer.from(wmtsRaw).toString();

    const zoomLevels = zoomLevelsFromWmts(wmts, tileMatrix);
    if (zoomLevels == null) return;

    return { path: 'overviews.tar.co', minZoom: zoomLevels.minZoom, maxZoom: zoomLevels.maxZoom };
  }
}

/** Attempt to parse a cotar WMTSCapabilties to figure out what zoom levels are applicable */
export function zoomLevelsFromWmts(
  wmts: string,
  tileMatrix: TileMatrixSet,
): { minZoom: number; maxZoom: number } | null {
  const owsIds = wmts
    .split('\n')
    .filter((f) => f.includes('ows:Identifier'))
    .map((c) => c.trim().replace('<ows:Identifier>', '').replace('</ows:Identifier>', ''));

  const tileMatrixOffset = owsIds.indexOf(tileMatrix.identifier);
  if (tileMatrixOffset === -1) return null;

  const minZoom = Number(owsIds[tileMatrixOffset + 1]);
  const maxZoom = Number(owsIds[owsIds.length - 1]);

  if (isNaN(minZoom)) return null;
  if (isNaN(maxZoom)) return null;
  if (maxZoom < minZoom) return null;
  if (maxZoom === 0) return null;
  return { minZoom, maxZoom };
}
