"""Indexed FEM boundary display; no nearest-point projection or decimation."""
import struct


def write_surface(path, fields, triangles):
    import numpy as np
    faces = np.asarray(triangles)
    count = fields["vonMises"].size
    if faces.ndim != 1 or not faces.size or faces.size % 3 or faces.dtype.kind not in "iu" or faces.min() < 0 or faces.max() >= count:
        raise ValueError("invalid FEM boundary topology")
    nodes, indices = np.unique(faces, return_inverse=True)
    if nodes.size > 500000 or faces.size // 3 > 1000000:
        # A large result remains downloadable; never silently sample triangles.
        return {"available": False, "reason": "boundary exceeds interactive display budget"}
    arrays = [fields["positions"].reshape(-1, 3)[nodes], fields["displacement"].reshape(-1, 3)[nodes], fields["vonMises"][nodes]]
    if any(not np.isfinite(array).all() for array in arrays) or np.any(arrays[2] < 0):
        raise ValueError("invalid FEM display field")
    with path.open("wb") as file:
        file.write(struct.pack("<8sII", b"VSURF001", nodes.size, faces.size // 3))
        for array in arrays:
            file.write(np.asarray(array, dtype="<f4").tobytes())
        file.write(np.asarray(indices, dtype="<u4").tobytes())
    return {"available": True, "schema": "vision.surface/1", "nodes": int(nodes.size),
            "triangles": int(faces.size // 3), "method": "indexed-fem-boundary", "stress": "nodal-averaged-von-mises"}
