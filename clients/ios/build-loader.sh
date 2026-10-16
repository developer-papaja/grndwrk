#!/bin/sh
# Build GrndwrkFeedback as one dylib for the iOS Simulator (arm64 and
# x86_64), with a loader that starts the Comment button by itself. Inject it
# into any app with DYLD_INSERT_LIBRARIES and GRNDWRK_FEEDBACK=1, without
# changing the app. Prints the path to put in the scheme.
#
#   sh clients/ios/build-loader.sh [output path]
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/GrndwrkFeedback/Sources/GrndwrkFeedback"
OUT="${1:-$HOME/Library/Developer/grndwrk/GrndwrkFeedbackLoader.dylib}"
MIN_IOS=15.0

command -v xcrun >/dev/null 2>&1 || { echo "Needs Xcode: xcrun was not found." >&2; exit 1; }
SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

for ARCH in arm64 x86_64; do
  TARGET="$ARCH-apple-ios$MIN_IOS-simulator"
  echo "Building for $TARGET..." >&2
  xcrun --sdk iphonesimulator clang -target "$TARGET" -isysroot "$SDK" -O2 \
    -c "$HERE/Loader/GrndwrkFeedbackLoader.m" -o "$WORK/loader-$ARCH.o"
  xcrun --sdk iphonesimulator swiftc -target "$TARGET" -sdk "$SDK" -swift-version 5 -O -D DEBUG \
    -module-name GrndwrkFeedback -emit-library \
    "$SOURCES"/*.swift "$HERE/Loader/Inject.swift" "$WORK/loader-$ARCH.o" \
    -Xlinker -install_name -Xlinker "$OUT" \
    -o "$WORK/GrndwrkFeedback-$ARCH.dylib"
done

mkdir -p "$(dirname "$OUT")"
lipo -create "$WORK/GrndwrkFeedback-arm64.dylib" "$WORK/GrndwrkFeedback-x86_64.dylib" -output "$OUT"
# The Simulator wants code signed; an ad hoc signature is enough.
codesign --force --sign - "$OUT" >/dev/null 2>&1

echo "Built $(lipo -archs "$OUT") for the iOS Simulator." >&2
echo "In the app's personal scheme, Run > Arguments > Environment Variables:" >&2
echo "  DYLD_INSERT_LIBRARIES = $OUT" >&2
echo "  GRNDWRK_FEEDBACK   = 1" >&2
echo "$OUT"
