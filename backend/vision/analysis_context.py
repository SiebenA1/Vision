"""Bounded geometry and study facts for the existing CAE planner tools."""


def analysis_context(workspace, document, revision_id, body_ids=None, offset=0, limit=24, candidate=None):
    geometry = document.get('geometry')
    if not geometry:
        raise ValueError('build geometry before planning an analysis')
    manifest = workspace.artifacts.manifest(geometry)
    bodies = manifest.get('bodies', [])
    study = document.get('study') or {}
    solids = {body['id']: body for body in bodies if body['kind'] == 'solid'}
    candidate_current = bool(candidate and (not candidate.get('body_ids') or candidate.get('body_artifact_id') == geometry))
    default_scope = (candidate.get('body_ids') or list(solids)) if candidate_current else None
    selected = body_ids if body_ids is not None else default_scope or study.get('body_ids') or list(solids)
    if not selected or any(identity not in solids for identity in selected):
        raise ValueError('analysis requires current closed solid body IDs')
    scope_current = not study.get('body_ids') or study.get('body_artifact_id') == geometry
    selected = list(dict.fromkeys(selected))
    faces = []
    for identity in selected:
        body = solids[identity]
        for face in body.get('faces', []):
            faces.append({'id': face['id'], 'body_id': identity, 'body_name': body['name'],
                          'area_mm2': face.get('area_mm2'), 'bbox_mm': face.get('bbox_mm')})
    warnings = []
    if not scope_current:
        warnings.append('saved_body_selection_is_stale: reselect before configuring or solving')
    if len(selected) > 1:
        warnings.append('multiple_solids: contact/bonding is unsupported; do not assume visible parts transmit force')
    def resolved_faces(item):
        region = item.get('region') or {}
        if region.get('type') == 'cad-face':
            if region.get('artifactId') != geometry:
                warnings.append('stale_face_region: ' + item['id'])
                return set()
            return set(region['faceIds'])
        if region.get('type') == 'semantic-object':
            obj = next((obj for obj in document.get('objects', []) if obj['id'] == region['object_id']), None)
            if not obj or obj['binding']['artifact_id'] != geometry:
                warnings.append('stale_semantic_region: ' + item['id'])
                return set()
            return set(obj['binding']['topology_ids'])
        return set()
    support_faces = set()
    for item in study.get('supports', []):
        if item.get('enabled', True):
            support_faces.update(resolved_faces(item))
    for item in study.get('loads', []):
        if not item.get('enabled', True):
            continue
        load_faces = resolved_faces(item)
        if support_faces & load_faces:
            warnings.append('same_fixed_and_loaded_face: ' + item['id'])
    known_faces = support_faces | set().union(*(resolved_faces(item) for item in study.get('loads', []) if item.get('enabled', True)))
    if any(face.split('/')[0] not in selected for face in known_faces):
        warnings.append('boundary_outside_requested_scope: reconfigure the boundary selections')
    return {
        'revision_id': revision_id, 'artifact_id': geometry,
        'scope': {'body_ids': selected, 'origin': 'requested_for_planning' if body_ids is not None else 'ui_candidate' if default_scope else 'saved_study' if study.get('body_ids') else 'all_closed_solids',
                  'saved_scope_current': scope_current, 'body_count': len(selected)},
        'bodies': [{key: solids[identity].get(key) for key in ('id', 'name', 'bbox_mm', 'volume_mm3', 'area_mm2')}
                   for identity in selected[:16]],
        'bodies_truncated': len(selected) > 16,
        'faces': faces[offset:offset + limit], 'face_count': len(faces), 'face_offset': offset,
        'next_face_offset': offset + limit if offset + limit < len(faces) else None,
        'saved_study': study or None,
        'candidate_study': candidate, 'candidate_geometry_current': candidate_current,
        'input_authority': 'Saved settings are facts about configuration, not proof of actual material, loads or mounting. UI drafts in messages are unsaved candidate inputs.',
        'warnings': list(dict.fromkeys(warnings)),
        'units': {'geometry': 'mm', 'force': 'N', 'stress': 'MPa', 'density': 'kg/m3'},
        'supported_physics': 'homogeneous isotropic small-strain linear static solid elasticity, fully fixed regions, area-distributed resultant forces',
        'limitations': [
            'No contact, bonding, plasticity, shell, buckling, fatigue or automatic self-weight.',
            'All active components need adequate supports. Do not union parts without an authorized physical idealization.',
            'Loads and supports cannot share FEM nodes; distinct adjacent faces can share edge nodes. Prefer separated physical end faces for an authorized cantilever idealization.',
            'Bounding boxes describe global extents, not face normals or proof of how a part is mounted.',
            'P1 tetrahedra may be stiff in bending. Recommend refinement comparison; a small residual is not mesh convergence.',
        ],
        'required_physical_inputs': ['analysis purpose', 'actual material or explicitly authorized example material',
                                     'mounting/fixed surface', 'force magnitude, direction and loaded surface'],
        'workflow': 'Clarify only missing critical facts. Explain purpose, idealization, parameter sources and mesh choice; configure_study, solve, then assessment when authorized. Missing design thresholds remain unknown.',
    }
