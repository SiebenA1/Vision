"""API v2 contracts; quantities use mm, N, MPa and kg."""
import math
import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


Identity = Annotated[str, Field(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9_.:-]+$")]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Vector = Annotated[list[float], Field(min_length=3, max_length=3)]
Face = Literal["x-min", "x-max", "y-min", "y-max", "z-min", "z-max"]


class Material(Contract):
    E: float = Field(gt=0)
    nu: float = Field(gt=-1, lt=.5)
    rho: float = Field(gt=0)
    yieldStrength: float = Field(gt=0)


class Box(Contract):
    type: Literal["box"]
    min: Vector
    max: Vector

    @model_validator(mode="after")
    def ordered(self):
        if any(a > b for a, b in zip(self.min, self.max)):
            raise ValueError("region min must not exceed max")
        return self


class Sphere(Contract):
    type: Literal["sphere"]
    center: Vector
    radius: float = Field(gt=0)


class NativeFace(Contract):
    type: Literal["cad-face"]
    artifactId: Digest
    faceIds: Annotated[list[Annotated[str, Field(pattern=r"^body-[0-9]+/face-[0-9]+$")]], Field(min_length=1, max_length=256)]
    toleranceMm: float = Field(gt=0, le=10)


class SemanticRegion(Contract):
    type: Literal["semantic-object"]
    object_id: Identity
    toleranceMm: float = Field(gt=0, le=10)


Region = Annotated[Box | Sphere | NativeFace | SemanticRegion, Field(discriminator="type")]


TopologyId = Annotated[str, Field(pattern=r"^body-[0-9]+(?:/(?:face|edge)-[0-9]+)?$")]


class Binding(Contract):
    artifact_id: Digest
    topology_ids: list[TopologyId] = Field(min_length=1, max_length=64)


class SemanticObject(Contract):
    id: Identity
    name: str = Field(min_length=1, max_length=200)
    source_event: Identity
    purpose: str = Field(min_length=1, max_length=2000)
    binding: Binding


class Support(Contract):
    id: Identity
    name: str = Field(default="Fixed", max_length=200)
    face: Face = "x-min"
    type: Literal["fixed"] = "fixed"
    enabled: bool = True
    region: Region | None = None


class Load(Contract):
    id: Identity
    name: str = Field(default="Force", max_length=200)
    face: Face = "x-max"
    vector: Vector
    magnitude: float = Field(gt=0)
    enabled: bool = True
    region: Region | None = None

    @model_validator(mode="after")
    def nonzero(self):
        if not math.hypot(*self.vector):
            raise ValueError("load vector must be nonzero")
        return self


class Study(Contract):
    material: Material
    supports: Annotated[list[Support], Field(min_length=1, max_length=64)]
    loads: Annotated[list[Load], Field(min_length=1, max_length=64)]
    mesh_size: float = Field(default=4, gt=0, le=10000)
    body_ids: list[Annotated[str, Field(pattern=r"^body-[0-9]+$")]] | None = Field(default=None,
        description="Omit/null to analyze all closed solids. Explicit IDs require body_artifact_id for the current geometry; do not invent IDs.")
    body_artifact_id: Digest | None = Field(default=None,
        description="Omit/null when body_ids is omitted/null. Set only together with explicit nonempty body_ids, using the current geometry digest.")

    @model_validator(mode="after")
    def active(self):
        for name, items in (("supports", self.supports), ("loads", self.loads)):
            if not any(item.enabled for item in items):
                raise ValueError(f"at least one enabled {name} is required")
            if len({item.id for item in items}) != len(items):
                raise ValueError(f"duplicate {name} identity")
        if self.body_ids is not None and (not self.body_ids or len(set(self.body_ids)) != len(self.body_ids)):
            raise ValueError("select unique solid bodies")
        if self.body_artifact_id is not None and not self.body_ids:
            raise ValueError("body artifact requires an explicit body selection")
        return self


class RequirementSpec(Contract):
    name: str = Field(min_length=1, max_length=200)
    metric: Literal["maxDisplacement", "maxVonMises", "mass_kg", "safetyFactor"]
    comparison: Literal["le", "ge"]
    threshold: float = Field(gt=0)
    unit: Literal["mm", "MPa", "kg", "1"]

    @model_validator(mode="after")
    def dimensional(self):
        units = {"maxDisplacement": "mm", "maxVonMises": "MPa", "mass_kg": "kg", "safetyFactor": "1"}
        if self.unit != units[self.metric] or self.comparison != ("ge" if self.metric == "safetyFactor" else "le"):
            raise ValueError("metric, unit and comparison are incompatible")
        return self


class Requirement(RequirementSpec):
    id: Identity
    source_event: Identity


class ModelingRequirement(Contract):
    name: str = Field(min_length=1, max_length=300)
    metric: Literal['body_count', 'solid_count', 'bbox_x_mm', 'bbox_y_mm', 'bbox_z_mm', 'volume_mm3', 'manual']
    minimum: float | None = Field(default=None, ge=0)
    maximum: float | None = Field(default=None, ge=0)
    source_ids: list[Identity] = Field(min_length=1, max_length=16)

    @model_validator(mode='after')
    def meaningful_bounds(self):
        if len(set(self.source_ids)) != len(self.source_ids):
            raise ValueError('duplicate modeling requirement sources')
        if self.metric == 'manual':
            if self.minimum is not None or self.maximum is not None:
                raise ValueError('manual features have no automatic numeric bounds')
        elif self.minimum is None and self.maximum is None:
            raise ValueError('a measurable modeling requirement needs a bound')
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError('minimum exceeds maximum')
        if self.metric in ('body_count', 'solid_count') and any(value is not None and not value.is_integer()
                                                              for value in (self.minimum, self.maximum)):
            raise ValueError('body counts must be integers')
        return self


def bounded_modeling_requirements(items):
    if len(json.dumps([item.model_dump() for item in items], ensure_ascii=False, separators=(',', ':'))) > 12000:
        raise ValueError('modeling requirements exceed the 12000-character context allowance; use concise criteria')
    return items


class ModelingComponent(Contract):
    name: str = Field(min_length=1, max_length=80)
    depends_on: list[str] = Field(default_factory=list, max_length=24)


def ordered_components(items):
    known = set()
    for item in items:
        if item.name in known or any(name not in known for name in item.depends_on):
            raise ValueError('component names must be unique and dependencies must precede the component')
        known.add(item.name)
    return items


class Document(Contract):
    schema_version: Literal["vision.project/2"] = "vision.project/2"
    name: str = Field(min_length=1, max_length=200)
    geometry: Digest | None = None
    study: Study | None = None
    legacy_source: Digest | None = None
    requirements: list[Requirement] = Field(default_factory=list, max_length=64)
    objects: list[SemanticObject] = Field(default_factory=list, max_length=64)
    modeling_requirements: list[ModelingRequirement] = Field(default_factory=list, max_length=24)
    modeling_plan: list[ModelingComponent] = Field(default_factory=list, max_length=24)
    _component_order = field_validator('modeling_plan')(ordered_components)
    _modeling_size = field_validator('modeling_requirements')(bounded_modeling_requirements)

    @model_validator(mode="after")
    def unique_identity(self):
        for items in (self.requirements, self.objects):
            if len({item.id for item in items}) != len(items):
                raise ValueError("duplicate engineering object or requirement identity")
        return self


class ReceiptInput(Contract):
    command_id: Identity
    idempotency_key: Identity


class CreateProject(ReceiptInput):
    name: str = Field(min_length=1, max_length=200)

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value):
        return value.strip() if isinstance(value, str) else value


class Edit(ReceiptInput):
    expected_head: Identity


class ConfigureStudy(Edit):
    study: Study


class SetModelingRequirements(Edit):
    requirements: list[ModelingRequirement] = Field(min_length=1, max_length=24)
    _modeling_size = field_validator('requirements')(bounded_modeling_requirements)
    components: list[ModelingComponent] | None = Field(default=None, max_length=24)

    @field_validator('components')
    @classmethod
    def component_order(cls, value):
        return ordered_components(value) if value is not None else None


class Rename(Edit):
    name: str = Field(min_length=1, max_length=200)
    require_idle: bool = False  # Preserve existing optimistic-head API behavior.

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value):
        return value.strip() if isinstance(value, str) else value


class DeleteProject(Edit):
    confirmed_name: str = Field(min_length=1, max_length=200)


class ModelSettings(ReceiptInput):
    model: Literal["deepseek-flash", "deepseek-v4-pro"]


class Restore(Edit):
    revision_id: Identity


class AdoptGeometry(Edit):
    job_id: Identity


CodeValue = float | int | str | bool


class CodeParameter(Contract):
    type: Literal['number','integer','string','boolean']
    default: CodeValue
    unit: str = Field(default='', max_length=32)
    minimum: float | None = None
    maximum: float | None = None

    @model_validator(mode='after')
    def bounds(self):
        if self.minimum is not None and self.maximum is not None and self.minimum>self.maximum:
            raise ValueError('module parameter bounds are reversed')
        if self.type in ('string','boolean') and (self.minimum is not None or self.maximum is not None):
            raise ValueError('numeric bounds require a numeric module parameter')
        return self


class CodeBinding(Contract):
    requirement_id: Identity
    source_id: Identity
    feature: str = Field(min_length=1,max_length=120)


class RegisterCodeModule(Edit):
    module_id: Identity
    description: str = Field(min_length=1,max_length=600)
    script: str = Field(min_length=1,max_length=40000)
    parameters: dict[str,CodeParameter] = Field(default_factory=dict,max_length=24)
    tags: list[str] = Field(default_factory=list,max_length=12)
    source_ids: list[Identity] = Field(min_length=1,max_length=16)
    bindings: list[CodeBinding] = Field(default_factory=list,max_length=24)

    @model_validator(mode='after')
    def bounded_metadata(self):
        if len({binding.requirement_id for binding in self.bindings})!=len(self.bindings):
            raise ValueError('module requirement binding IDs must be unique')
        if len(json.dumps(self.model_dump(exclude={'script','command_id','idempotency_key','expected_head'}),ensure_ascii=False))>8000:
            raise ValueError('module interface metadata exceeds 8000 characters')
        return self


class CodeReference(Contract):
    module_id: Identity
    code_revision: Digest


class ReadCodeModule(CodeReference):
    offset: int = Field(default=0,ge=0,le=40000)
    limit: int = Field(default=2000,ge=1,le=6000)


class SearchCodeModules(Contract):
    query: str = Field(default='',max_length=300)
    tags: list[str] = Field(default_factory=list,max_length=12)
    parameter_names: list[str] = Field(default_factory=list,max_length=24)
    limit: int = Field(default=4,ge=1,le=8)
    semantic: bool = False


class CodeParameterRef(Contract):
    component_id: Identity
    parameter: str = Field(min_length=1,max_length=160)
    scale: float = 1
    offset: float = 0


class CodeInstance(CodeReference):
    component_id: Identity
    parameters: dict[str,CodeValue | CodeParameterRef] = Field(default_factory=dict,max_length=24)
    depends_on: list[Identity] = Field(default_factory=list,max_length=24)
    translation: list[float | int | CodeParameterRef] = Field(default_factory=lambda:[0.,0.,0.],min_length=3,max_length=3)
    rotation_deg: Vector = Field(default_factory=lambda:[0.,0.,0.])
    requirement_ids: list[Identity] = Field(default_factory=list,max_length=24)


class Build(Edit):
    expected_impact_digest: Digest | None = None
    script: str = Field(default='', max_length=200000)
    parameters: dict[str, float | str | bool] = Field(default_factory=dict)
    tolerance_mm: float = Field(default=.05, ge=.00001, le=10)
    angle_deg: float = Field(default=10, ge=.1, le=45)
    use_current: bool = True
    replay_of: Digest | None = None
    module_assembly: list['CodeInstance'] | None = Field(default=None, min_length=1, max_length=24)

    @model_validator(mode="after")
    def replay_source(self):
        if not self.script and not self.module_assembly:
            raise ValueError('a script or a module assembly is required')
        if self.module_assembly and self.replay_of:
            raise ValueError('module assemblies use their component plan, not whole-script replay')
        if self.replay_of and self.use_current:
            raise ValueError("replay uses original build inputs, not the current body")
        return self


class Solve(Edit):
    pass


class LegacyPreview(Contract):
    legacy_model: dict


class LegacyImport(ReceiptInput):
    legacy_model: dict
    study: Study | None = None


class AddRequirement(Edit):
    statement: str = Field(min_length=1, max_length=16000, pattern=r"\S")
    requirement: RequirementSpec


class RemoveRequirement(Edit):
    requirement_id: Identity


class AddObject(Edit):
    artifact_id: Digest
    name: str = Field(min_length=1, max_length=200)
    purpose: str = Field(min_length=1, max_length=2000, pattern=r"\S")
    topology_ids: list[TopologyId] = Field(min_length=1, max_length=64)


class RebindObject(Edit):
    artifact_id: Digest
    object_id: Identity
    topology_ids: list[TopologyId] = Field(min_length=1, max_length=64)


class Pick(Contract):
    kind: Literal["body", "face", "edge"]
    point: Vector
    tolerance_mm: float = Field(gt=0, le=10)


class InspectGeometry(Contract):
    revision_id: Identity
    artifact_id: Digest
    selection: list[TopologyId] = Field(default_factory=list, max_length=64)
    pick: Pick | None = None

    @model_validator(mode="after")
    def unique_selection(self):
        if len(set(self.selection)) != len(self.selection):
            raise ValueError("duplicate topology selection")
        return self


class TaskStep(Contract):
    tool: Literal["preview_build", "build_geometry", "configure_study", "solve", "assessment", "search_sources", "remember", "read_source", "read_tool_result", "read_script", "inspect_geometry", "list_topology", "ask_user", "native_api", "analysis_context", "beam_reference", "solver_validation", "finish", 'set_modeling_requirements', 'check_modeling', 'register_code_module', 'search_code_modules', 'read_code_module', 'patch_code_module', 'read_code_assembly', 'read_batch']
    arguments: dict = Field(default_factory=dict)


class CreateTask(Edit):
    statement: str = Field(min_length=1, max_length=16000, pattern=r"\S")
    plan: list[TaskStep] = Field(min_length=1, max_length=24)
    max_jobs: int = Field(default=3, ge=1, le=8)


class CorrectTask(Edit):
    expected_epoch: int = Field(ge=1)
    statement: str = Field(min_length=1, max_length=16000, pattern=r"\S")
    plan: list[TaskStep] = Field(min_length=1, max_length=24)


class CreateModelTask(Edit):
    statement: str = Field(min_length=1, max_length=16000, pattern=r"\S")
    max_jobs: int = Field(default=3, ge=1, le=8)
    max_requests: int = Field(default=12, ge=1, le=24)
    unlimited: bool = True


class StudyDraft(Contract):
    """A bounded UI candidate, allowed to lack supports/loads; never solver admission."""
    material: Material
    supports: list[Support] = Field(default_factory=list, max_length=64)
    loads: list[Load] = Field(default_factory=list, max_length=64)
    mesh_size: float = Field(default=4, gt=0, le=10000)
    body_ids: list[Annotated[str, Field(pattern=r'^body-[0-9]+$')]] | None = Field(default=None, min_length=1, max_length=64)
    body_artifact_id: Digest | None = None


class ConversationMessage(Edit):
    text: str = Field(min_length=1, max_length=16000, pattern=r"\S")
    expected_task: Identity | None = None
    expected_epoch: int | None = Field(default=None, ge=1)
    artifact_id: str | None = None
    selection: list[TopologyId] = Field(default_factory=list, max_length=64)
    analysis_draft: StudyDraft | None = None

    @field_validator('analysis_draft')
    @classmethod
    def bounded_analysis_draft(cls, value):
        if value and len(json.dumps(value.model_dump(exclude_none=True), ensure_ascii=False)) > 10000:
            raise ValueError('analysis draft is too large; simplify the study first')
        return value


class CorrectModelTask(CreateModelTask):
    expected_epoch: int = Field(ge=1)


class StopTask(ReceiptInput):
    expected_epoch: int = Field(ge=1)


class ForgetSource(ReceiptInput):
    source_id: Identity


class Remember(Edit):
    kind: Literal["requirement", "decision", "open_question", "stage"]
    summary: str = Field(min_length=1, max_length=2000, pattern=r"\S")
    source_ids: list[Identity] = Field(min_length=1, max_length=16)
    supersedes: list[Identity] = Field(default_factory=list, max_length=16)
    scope: Literal["project", "geometry"] = "project"

    @model_validator(mode="after")
    def unique_sources(self):
        if len(set(self.source_ids)) != len(self.source_ids) or len(set(self.supersedes)) != len(self.supersedes):
            raise ValueError("duplicate memory sources")
        return self


class UISettings(ReceiptInput):
    theme: Literal["system", "light", "dark"] = "system"
    sidebar_collapsed: bool = False
    chat_width: int = Field(default=380, ge=320, le=520)


class HumanMemory(Remember):
    source_ids: list[Identity] = Field(default_factory=list, max_length=16)
    scope: Literal["project", "geometry", "revision"] = "project"


class MemoryState(Edit):
    source_id: Identity
    enabled: bool


class BeamReference(Contract):
    kind: Literal["axial", "cantilever"]
    length_mm: float = Field(ge=.001, le=100000)
    width_mm: float = Field(ge=.001, le=100000)
    height_mm: float = Field(ge=.001, le=100000)
    elastic_modulus_mpa: float = Field(ge=.001, le=1000000000)
    force_n: float = Field(gt=0, le=1000000000)
    density_kg_m3: float = Field(gt=0, le=1000000)


class VerifySolver(ReceiptInput):
    suite: Literal["standard", "extended"] = "standard"
