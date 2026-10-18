from build123d import *

R = 228.5
W = 203.0
with BuildPart() as wheel:
    Cylinder(R, W)
    Cylinder(R - 14, W + 20, mode=Mode.SUBTRACT)
    with Locations((0, 0, W / 2 - 8), (0, 0, -W / 2 + 8)):
        Cylinder(R + 9, 16)
        Cylinder(R - 14, 24, mode=Mode.SUBTRACT)
    Cylinder(84, 100)
    Cylinder(36.3, 120, mode=Mode.SUBTRACT)
    with PolarLocations(145, 9):
        Box(30, 150, 26)
    with PolarLocations(57.15, 5):
        Cylinder(8.5, 120, mode=Mode.SUBTRACT)
result = wheel.part
