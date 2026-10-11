# Alternative: datadog-ci（CI/CD 场景）

> `datadog` 技能的伴随文件。仅在 CI/CD 流水线里需要上传产物 / 触发合成测试时读。

For CI/CD operations, use `datadog-ci`:

```bash
# Install
npm install -g @datadog/datadog-ci

# Upload sourcemaps
datadog-ci sourcemaps upload ./dist --service my-app --release-version 1.0.0

# Upload test results
datadog-ci junit upload --service my-app ./test-results/*.xml

# Trigger Synthetic tests
datadog-ci synthetics run-tests --public-id abc-123
```
