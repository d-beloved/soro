"""Packs the "soro-models" Modal volume into one tar on a "soro-transfer" volume, for copying to the AWS server.

`modal volume get` on its own drops symlinks, and the Hugging Face cache needs them (snapshots/ links to blobs/), so
the speech models fail to load from a plain copy. A tar keeps them. See README.md, step 3.

  uvx modal run pack_models.py
"""

import modal

app = modal.App("soro-pack-models")
models = modal.Volume.from_name("soro-models").read_only()
transfer = modal.Volume.from_name("soro-transfer", create_if_missing=True)


@app.function(
    image=modal.Image.debian_slim(python_version="3.12"),
    volumes={"/models": models, "/out": transfer},
    cpu=4,
    timeout=3600,
)
def pack() -> str:
    import os
    import subprocess

    subprocess.run(["tar", "-cf", "/out/models.tar", "-C", "/models", "."], check=True)
    transfer.commit()
    return f"models.tar: {os.path.getsize('/out/models.tar') / 1e9:.1f} GB"


@app.local_entrypoint()
def main():
    print(pack.remote())
