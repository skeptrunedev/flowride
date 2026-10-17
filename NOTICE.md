# Third-party notices

The MIT license in this repository applies to Flow Ride's application code. It does not replace the terms covering third-party data, map imagery or dependencies.

## OpenStreetMap and route data

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/).

`public/scenic-route.json` contains a driving route returned by the public [OSRM](https://project-osrm.org/) service on 2026-10-17 using OpenStreetMap data. It is supplied as an example route with this source attribution; the repository's MIT license does not relicense the underlying map data.

The app loads raster tiles from `tile.openstreetmap.org` and displays attribution. Tile use is subject to the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/). Screenshots in `docs/images/` show the app with OpenStreetMap tiles and retain visible attribution.

## Dependencies

React, Vite and their supporting packages, Leaflet, Lucide, Wrangler and Prettier retain their respective licenses distributed with those packages. Exact installed versions are recorded in `package-lock.json`. No third-party package is relicensed by this repository.
