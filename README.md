# RImage

Compress selected images in Wox with the bundled [rimage](https://github.com/vlad-salone/rimage) CLI.

## Usage

Select one or more image files, open Wox selection query, then run the RImage result.

Supported formats:

- JPEG: compressed with `mozjpeg`
- PNG: compressed with `oxipng`
- WebP: compressed with `webp`
- AVIF: compressed with `avif`

The plugin compresses files in place and lets rimage keep the original files as `@backup` backups.

# Install

```
wpm install RImage
```
