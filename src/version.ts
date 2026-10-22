declare const __CLI_VERSION__: string | undefined

// scripts/build.ts injects the package version; running from source reports a development marker.
export const VERSION: string = typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0-dev'
