import { TileMatrixSet } from '@basemaps/geo';
import { LambdaContext } from '@basemaps/lambda';
import { LogConfig, TileMetadataProviderRecord } from '@basemaps/shared';
import { TileSet } from '../tile.set';

export function mockRequest(path: string, method = 'get', headers = {}): LambdaContext {
    return new LambdaContext(
        {
            requestContext: null as any,
            httpMethod: method.toUpperCase(),
            path,
            headers,
            body: null,
            isBase64Encoded: false,
        },
        LogConfig.get(),
    );
}

export class FakeTileSet extends TileSet {
    constructor(name: string, tileMatrix: TileMatrixSet, title = `${name}:title`, description = `${name}:description`) {
        super(name, tileMatrix);
        this.tileSet = { title, description } as any;
    }
}

export const Provider: TileMetadataProviderRecord = {
    createdAt: Date.now(),
    id: 'pv_production',
    updatedAt: Date.now(),
    version: 1,
    revisions: 0,
    serviceIdentification: {
        accessConstraints: 'the accessConstraints',
        description: 'the description',
        fees: 'the fees',
        title: 'the title',
    },
    serviceProvider: {
        contact: {
            address: {
                city: 'the city',
                country: 'the country',
                deliveryPoint: 'the deliveryPoint',
                email: 'email address',
                postalCode: 'the postalCode',
            },
            individualName: 'the contact name',
            phone: 'the phone',
            position: 'the position',
        },
        name: 'the name',
        site: 'https://example.provider.com',
    },
};
