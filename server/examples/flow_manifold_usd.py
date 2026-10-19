"""A flanged T-manifold: intersecting flow channels, mounting holes and curved walls."""
import usd_brep as u

height = float(parameters.setdefault("height_mm", 80))
branch_length = float(parameters.setdefault("branch_length_mm", 50))
outer_radius = float(parameters.setdefault("outer_radius_mm", 12))
wall = float(parameters.setdefault("wall_mm", 3))
body = u.create_cylinder((0,0,0), outer_radius, height)
flange = u.create_box((-30,-30,0),60,60,8)
body = u.boolean_union(body, flange)
branch = u.create_cylinder((0,0,0),outer_radius,branch_length)
u.rotate(branch,(0,0,0),(0,1,0),90)
u.translate(branch,(0,0,height/2))
body = u.boolean_union(body, branch)
body = u.boolean_difference(body,u.create_cylinder((0,0,-1),outer_radius-wall,height+2))
bore=u.create_cylinder((0,0,-1),outer_radius-wall,branch_length+2)
u.rotate(bore,(0,0,0),(0,1,0),90)
u.translate(bore,(0,0,height/2))
body=u.boolean_difference(body,bore)
for x in (-22,22):
    for y in (-22,22):
        body=u.boolean_difference(body,u.create_cylinder((x,y,-1),3,10))
result={"manifold":body}
