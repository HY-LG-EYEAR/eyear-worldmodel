# EYEAR World Model and Simulation

Owner: **Hyochang Lee** | Part of [EYEAR](https://github.com/HY-LG-EYEAR)

> Status: repository scaffold and implementation plan. This upload kit does not contain runnable services, approved new contracts, trained models, or measured results. Preserve existing implementation files when adding this scaffold.

## Responsibility

Fuse semantic events into the canonical home state and implement the home/virtual-appliance simulation. This repository reuses the former eyear-data repository; it is not the agent training dataset repository.

Preserve room occupancy independently of track availability. Keep identity sources and uncertainty visible, reject reversed observations, track stale sources, and publish monotonically versioned home state. Simulated devices return observed acceptance/failure/completion instead of assuming a command succeeded.

Simulation scope includes room geometry, furniture, Node placement, residents, activities, vacuum routes/dock, washer state, AC target/airflow, lights and curtains. Rendering technology and physical-model fidelity are not finalized. Coordinate embedding in the Next.js interface with Yewon.

## Inputs and outputs

Consumes SemanticEvent and execution feedback; publishes WorldSnapshot to the Orchestrator and visualization state to the application. App preferences must be joined through one documented path. Canonical world revision ownership belongs here.

The authoritative shared contract release is maintained in [LG-EYEAR/contracts](https://github.com/HY-LG-EYEAR/LG-EYEAR/tree/main/contracts). Coordinate changes with producers and consumers; do not create an incompatible local contract under the same version.

## Structure

| Path | Intended content |
| --- | --- |
| `src/` | World-state fusion, source availability, coordinate transforms and versioned snapshot publication. |
| `simulation/` | Home state, resident/device dynamics and rendering. Distinguish authored ground truth from inferred state. |
| `configs/` | Floor plan, topology, calibration, device capabilities and agreed room relationships. |
| `fixtures/` | Small non-sensitive Node events and scenario inputs pinned to contract versions. |
| `tests/` | Ordering, unknown states, feedback, multi-person references and replay-clock tests. |

## Setup and execution status

This scaffold introduces no runtime dependencies or working launch commands. Preserve existing code. The owner must add the actual prerequisites, pinned dependency installation, configuration example, start/stop commands, and one verified smoke-test procedure before marking this repository runnable. Separate existing prototype instructions from the planned integrated system.

## Verification checklist

- [ ] Shared contract version and valid/invalid examples are identified.
- [ ] Dependencies and OS/hardware versions are recorded.
- [ ] A mock-input smoke test is reproducible.
- [ ] Missing, stale, unknown and invalid input behavior is tested.
- [ ] Integration with the next component is verified and exact commits are recorded.
- [ ] Current limitations and measured results are documented without invented metrics.

## Documentation

- [Integration and scenarios](https://github.com/HY-LG-EYEAR/LG-EYEAR)
- [CSE406 engineering document](https://github.com/HY-LG-EYEAR/LG-EYEAR-docs)
- [ITE351 research blog](https://github.com/HY-LG-EYEAR/LG-EYEAR-blog)

> Independent academic prototype. EYEAR is not an official LG Electronics product. The course prototype does not modify ThinQ ON firmware, integrate with the production ThinQ application, or control physical LG appliances.
