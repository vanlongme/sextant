const POD = `apiVersion: v1
kind: Pod
metadata:
  name: example
  labels:
    app: example
spec:
  containers:
    - name: main
      image: registry.k8s.io/pause:3.10
`;

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
  labels:
    app: example
spec:
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: main
          image: registry.k8s.io/pause:3.10
`;

const SERVICE = `apiVersion: v1
kind: Service
metadata:
  name: example
spec:
  selector:
    app: example
  ports:
    - port: 80
      targetPort: 8080
`;

const CONFIG_MAP = `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
data:
  key: value
`;

const SECRET = `apiVersion: v1
kind: Secret
metadata:
  name: example
type: Opaque
stringData:
  key: value
`;

const JOB = `apiVersion: batch/v1
kind: Job
metadata:
  name: example
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: main
          image: registry.k8s.io/pause:3.10
`;

const CRON_JOB = `apiVersion: batch/v1
kind: CronJob
metadata:
  name: example
spec:
  schedule: "0 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: main
              image: registry.k8s.io/pause:3.10
`;

const INGRESS = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: example
spec:
  rules:
    - host: example.test
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: example
                port:
                  number: 80
`;

const PERSISTENT_VOLUME_CLAIM = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: example
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`;

const NAMESPACE = `apiVersion: v1
kind: Namespace
metadata:
  name: example
`;

/** What the create tab can start from. No namespace: the tab supplies a default. */
export const TEMPLATES: { id: string; label: string; yaml: string }[] = [
  { id: "pod", label: "Pod", yaml: POD },
  { id: "deployment", label: "Deployment", yaml: DEPLOYMENT },
  { id: "service", label: "Service", yaml: SERVICE },
  { id: "configmap", label: "ConfigMap", yaml: CONFIG_MAP },
  { id: "secret", label: "Secret", yaml: SECRET },
  { id: "job", label: "Job", yaml: JOB },
  { id: "cronjob", label: "CronJob", yaml: CRON_JOB },
  { id: "ingress", label: "Ingress", yaml: INGRESS },
  {
    id: "persistentvolumeclaim",
    label: "PersistentVolumeClaim",
    yaml: PERSISTENT_VOLUME_CLAIM,
  },
  { id: "namespace", label: "Namespace", yaml: NAMESPACE },
];
