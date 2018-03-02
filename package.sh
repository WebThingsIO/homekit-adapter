#!/bin/bash

set -e

version=$(grep version package.json | cut -d: -f2 | cut -d\" -f2)

# Clean up from previous releases
rm -rf *.tgz package
rm -f SHA256SUMS
rm -rf lib

# Prep new package
mkdir lib
mkdir package

# Pull down Python dependencies
pip3 install -r requirements.txt -t lib --prefix ""

# Put package together
cp -r lib pkg LICENSE package.json *.py package/
find package -type f -name '*.pyc' -delete
find package -type d -empty -delete

# Generate checksums
cd package
sha256sum *.py pkg/*.py LICENSE > SHA256SUMS
find lib -type f -exec sha256sum {} \; >> SHA256SUMS
cd -

# Make the tarball
tar czf "homekit-adapter-${version}.tgz" package
