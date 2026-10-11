---
name: kubernetes
description: Manage Kubernetes clusters via the kubectl CLI.
metadata:
  displayName: Kubernetes
  icon: cloud
  category: cloud
  version: 1.0.0
---

# kubectl

Use `kubectl` to interact with Kubernetes clusters.

## Common Commands

### Pods

- List pods: `kubectl get pods`
- Describe pod: `kubectl describe pod <pod-name>`
- Logs: `kubectl logs <pod-name>`
- Exec: `kubectl exec -it <pod-name> -- /bin/bash`

### Deployments

- List deployments: `kubectl get deployments`
- Scale: `kubectl scale deployment <name> --replicas=3`

### Services

- List services: `kubectl get services`

### Context

- Get context: `kubectl config current-context`
- Use context: `kubectl config use-context <context-name>`

## Notes

- Requires `kubectl` to be installed and configured (`~/.kube/config`).
- xzh does **not** install `kubectl` for you (only `playwright` and `officecli` are
  auto-installed) — install it yourself: <https://kubernetes.io/docs/tasks/tools/> (macOS: `brew install kubectl`).
