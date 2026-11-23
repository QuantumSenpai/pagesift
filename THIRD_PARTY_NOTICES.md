# Third-Party Notices

PageSift is licensed under the MIT License (see [LICENSE](LICENSE)).

It incorporates or depends on the following open-source packages and bundled typefaces:

## Bundled Local Fonts (`dist/extension/fonts/`)

1. **Instrument Sans** (`@fontsource/instrument-sans`)
   - License: SIL Open Font License 1.1 (OFL-1.1)
   - Upstream Project: https://github.com/Instrument/instrument-sans
   - Packaging: https://github.com/fontsource/font-files
   - Bundled Locally: Latin `400`, `500`, `600`, `700` `.woff2` files shipped inside `dist/extension/fonts/` (zero external font CDN requests at runtime).
2. **IBM Plex Mono** (`@fontsource/ibm-plex-mono`)
   - License: SIL Open Font License 1.1 (OFL-1.1)
   - Copyright (c) 2017 IBM Corp.
   - Upstream Project: https://github.com/IBM/plex
   - Packaging: https://github.com/fontsource/font-files
   - Bundled Locally: Latin `400`, `500`, `600` `.woff2` files shipped inside `dist/extension/fonts/` (zero external font CDN requests at runtime).

## Extension & Shared Runtime Dependencies

3. **dompurify (`3.4.18`)**
   - License: MPL-2.0 OR Apache-2.0
   - Repository: https://github.com/cure53/DOMPurify
   - Copyright (c) Mario Heiderich, Cure53
4. **fflate (`0.8.3`)**
   - License: MIT
   - Repository: https://github.com/101arrowz/fflate
   - Copyright (c) 2020 Arjun Barrett
5. **idb (`8.0.4`)**
   - License: ISC
   - Repository: https://github.com/jakearchibald/idb
   - Copyright (c) Jake Archibald
6. **zod (`4.6.7`)**
   - License: MIT
   - Repository: https://github.com/colinhacks/zod
   - Copyright (c) Colin McDonnell

## Optional Backend Runtime Dependencies

7. **fastify (`5.12.8`)**, **`@fastify/cors (`11.4.3`)**, **`@fastify/helmet (`13.2.0`)**, **`@fastify/rate-limit (`11.3.0`)**, **`@fastify/swagger (`9.9.5`)**
   - License: MIT
   - Repository: https://github.com/fastify/fastify
   - Copyright (c) Fastify Contributors
8. **kysely (`0.29.9`)**
   - License: MIT
   - Repository: https://github.com/kysely-org/kysely
   - Copyright (c) Sami Koskimäki
9. **pg (`8.23.1`)**
   - License: MIT
   - Repository: https://github.com/brianc/node-postgres
   - Copyright (c) Brian Carlson
10. **openid-client (`6.9.1`)** & **jose (`6.2.18`)**
    - License: MIT
    - Repository: https://github.com/panva/openid-client & https://github.com/panva/jose
    - Copyright (c) Filip Skokan

## Motion Lab Reference & Ported Algorithms

11. **Reanimate**
    - License: MIT
    - Repository: https://github.com/NiazMorshed2007/reanimate
    - Copyright (c) 2026 Niaz Morshed
    - Notice: PageSift's Motion Lab specification, cubic-bezier curve-fitting tables/algorithmic structure, frame comparison metrics, and Reanimate artifact importer were informed by and incorporate MIT-licensed reference designs from Reanimate (`skills/reanimate`). The full MIT License text from Reanimate is preserved below:

```text
MIT License

Copyright (c) 2026 Niaz Morshed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
