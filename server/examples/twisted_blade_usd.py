"""Parameterized NACA-style solid loft with twist and a fused root connector.
Geometry demonstration only: no composite layup or aerodynamic loading is implied.
"""
import math
import usd_brep as u

span = float(parameters.setdefault("span_mm", 300))
root_chord = float(parameters.setdefault("root_chord_mm", 80))
tip_chord = float(parameters.setdefault("tip_chord_mm", 25))
twist = float(parameters.setdefault("twist_deg", 20))
profiles = []
for section in range(8):
    station = section / 7
    chord = root_chord + (tip_chord - root_chord) * station
    angle = math.radians(twist * station)
    upper, lower = [], []
    for index in range(25):
        x = (1 - math.cos(math.pi * index / 24)) / 2
        thickness = 5 * 0.16 * (0.2969 * math.sqrt(x) - 0.1260*x - 0.3516*x*x + 0.2843*x**3 - 0.1036*x**4)
        for points, sign in ((upper, 1), (lower, -1)):
            px, py = (x - .25) * chord, sign * thickness * chord
            points.append((px*math.cos(angle)-py*math.sin(angle), px*math.sin(angle)+py*math.cos(angle), station*span))
    profiles.extend([u.create_curve_interp_points(upper), u.create_curve_interp_points(list(reversed(lower)))])
blade = u.create_skin_primitive([2]*8, profiles, degree=3)
root = u.create_cylinder((0,0,-25), 15, 35)
result = {"blade": u.boolean_union(blade, root)}
