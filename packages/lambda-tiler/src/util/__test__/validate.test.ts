import assert from 'node:assert';
import { describe, it } from 'node:test';

import { GoogleTms, ImageFormat, Nztm2000QuadTms, Nztm2000Tms, VectorFormat } from '@basemaps/geo';

import { mockUrlRequest } from '../../__tests__/xyz.util.js';
import { Validate } from '../validate.js';

describe('GetImageFormats', () => {
  it('should parse all formats', () => {
    const req = mockUrlRequest('/v1/blank', 'format=png&format=jpeg');
    const formats = Validate.getRequestedFormats(req);
    assert.deepEqual(formats, [ImageFormat.Png, ImageFormat.Jpeg]);
  });

  it('should ignore bad formats', () => {
    const req = mockUrlRequest('/v1/blank', 'format=fake&format=mvt');
    const formats = Validate.getRequestedFormats(req);
    assert.equal(formats, null);
  });

  it('should de-dupe formats', () => {
    const req = mockUrlRequest('/v1/blank', 'format=png&format=jpeg&format=png&format=jpeg&format=png&format=jpeg');
    const formats = Validate.getRequestedFormats(req);
    assert.deepEqual(formats, [ImageFormat.Png, ImageFormat.Jpeg]);
  });

  it('should support "tileFormat" Alias all formats', () => {
    const req = mockUrlRequest('/v1/blank', 'tileFormat=png&format=jpeg');
    const formats = Validate.getRequestedFormats(req);
    assert.deepEqual(formats, [ImageFormat.Jpeg, ImageFormat.Png]);
  });

  it('should not duplicate "tileFormat" alias all formats', () => {
    const req = mockUrlRequest('/v1/blank', 'tileFormat=jpeg&format=jpeg');
    const formats = Validate.getRequestedFormats(req);
    assert.deepEqual(formats, [ImageFormat.Jpeg]);
  });
});

describe('getTileMatrixSet', () => {
  it('should lookup epsg codes', () => {
    assert.equal(Validate.getTileMatrixSet('EPSG:3857')?.identifier, GoogleTms.identifier);
    assert.equal(Validate.getTileMatrixSet('EPSG:2193')?.identifier, Nztm2000Tms.identifier);

    assert.equal(Validate.getTileMatrixSet('3857')?.identifier, GoogleTms.identifier);
    assert.equal(Validate.getTileMatrixSet('2193')?.identifier, Nztm2000Tms.identifier);
  });

  it('should lookup by identifier', () => {
    assert.equal(Validate.getTileMatrixSet('WebMercatorQuad')?.identifier, GoogleTms.identifier);
    assert.equal(Validate.getTileMatrixSet('NZTM2000Quad')?.identifier, Nztm2000QuadTms.identifier);
    assert.equal(Validate.getTileMatrixSet('Nztm2000')?.identifier, Nztm2000Tms.identifier);
  });

  it('should be case sensitive', () => {
    assert.equal(Validate.getTileMatrixSet('Nztm2000Quad')?.identifier, undefined);
  });
});

describe('getTileFormat', () => {
  for (const ext of Object.values(ImageFormat)) {
    it('should support image format:' + ext, () => {
      assert.equal(Validate.getTileFormat(ext), ext);
    });
  }

  it('should support vector format: mvt', () => {
    assert.equal(Validate.getTileFormat('pbf'), VectorFormat.MapboxVectorTiles);
  });

  for (const fmt of ['FAKE', /* 'JPEG' // TODO should this be case sensitive ,*/ 'mvt', 'json']) {
    it('should not support format:' + fmt, () => {
      assert.equal(Validate.getTileFormat(fmt), null);
    });
  }
});
