import math
# Concept geometry, mm. Connected annular rotor with radial vents and mounting hat.
r_outer = float(parameters.get('outer_r', 175.0))
r_inner = float(parameters.get('ring_inner_r', 105.0))
disc_t = float(parameters.get('disc_t', 32.0))
plate_t = float(parameters.get('plate_t', 9.0))
vent_t = disc_t - 2 * plate_t
n_vanes = int(parameters.get('n_vanes', 24))
hat_r = float(parameters.get('hat_r', 88.0))
hat_h = float(parameters.get('hat_t', 42.0))
hole_r = float(parameters.get('hat_inner_r', 44.0))
assert r_outer > r_inner > hat_r > hole_r > 0 and vent_t > 0
# Start with one connected ring, then cut radial channels through the rim.
body = u.create_cylinder(origin=(0,0,0), radius=r_outer, height=disc_t)
body = u.boolean_difference(body, u.create_cylinder(origin=(0,0,-1), radius=r_inner, height=disc_t+2))
channel_width = 18.0
for i in range(n_vanes):
    cutter = u.create_box(origin=(r_inner-2,-channel_width/2,plate_t),
                          length=r_outer-r_inner+4, width=channel_width, height=vent_t)
    u.rotate(cutter,(0,0,0),(0,0,1),360.0*i/n_vanes)
    body = u.boolean_difference(body,cutter)
# The base flange overlaps the friction ring; the sleeve overlaps that flange.
flange = u.create_cylinder(origin=(0,0,0), radius=r_inner+8, height=6)
flange = u.boolean_difference(flange,u.create_cylinder(origin=(0,0,-1),radius=hole_r,height=8))
body = u.boolean_union(body,flange)
hat = u.create_cylinder(origin=(0,0,0),radius=hat_r,height=hat_h)
hat = u.boolean_difference(hat,u.create_cylinder(origin=(0,0,-1),radius=hole_r,height=hat_h+2))
body = u.boolean_union(body,hat)
for i in range(5):
    a=2*math.pi*i/5
    cutter=u.create_cylinder(origin=(62*math.cos(a),62*math.sin(a),-1),radius=7,height=hat_h+2)
    body=u.boolean_difference(body,cutter)
result={'ventilated_brake_disc':body}
