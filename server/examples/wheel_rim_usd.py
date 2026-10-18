"""18-inch 9-spoke wheel authored with NVIDIA USD BRep.

Run through the VISION backend worker, not as a standalone script:
the worker tessellates `result` and computes exact metrics.
"""
import math

import usd_brep as u

R = 228.6          # 18 in outer radius, mm
W = 203.2          # rim width, mm
RIM_T = 14.0
HUB_R = 46.0

# Rim barrel
outer = u.create_cylinder((0, 0, -W / 2), R, W)
inner = u.create_cylinder((0, 0, -W / 2 - 1), R - RIM_T, W + 2)
wheel = u.boolean_difference(outer, inner)

# Hub
hub = u.create_cylinder((0, 0, -W / 2 - 2), HUB_R, W + 4)
wheel = u.boolean_union(wheel, hub)

# 9 radial spokes
spoke = u.create_box((HUB_R - 4, -11, -12), R - HUB_R, 22, 24)
for index in range(9):
    copy = spoke.copy()
    u.rotate(copy, (0, 0, 0), (0, 0, 1), index * 40.0)
    wheel = u.boolean_union(wheel, copy)

# Centre bore
bore = u.create_cylinder((0, 0, -W / 2 - 4), 36.3, W + 8)
wheel = u.boolean_difference(wheel, bore)

# 5 lug holes on 114.3 mm PCD
for index in range(5):
    angle = math.radians(index * 72.0)
    px = math.cos(angle) * 114.3 / 2
    py = math.sin(angle) * 114.3 / 2
    hole = u.create_cylinder((px, py, -W / 2 - 4), 8.5, W + 8)
    wheel = u.boolean_difference(wheel, hole)

result = wheel
