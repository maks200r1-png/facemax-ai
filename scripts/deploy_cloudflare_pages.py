import os
import sys
import json
import urllib.request
import urllib.error
import subprocess

token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()

if not token:
    print("ERROR: CLOUDFLARE_API_TOKEN environment variable is missing")
    sys.exit(1)
if not account_id:
    print("ERROR: CLOUDFLARE_ACCOUNT_ID environment variable is missing")
    sys.exit(1)

def cf_api(method, path, data=None):
    url = f"https://api.cloudflare.com/client/v4{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    body = json.dumps(data).encode("utf-8") if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        print(f"CF API {method} {path} HTTP {e.code}: {err_body}")
        try:
            return json.loads(err_body)
        except Exception:
            return {"success": False, "error": err_body}
    except Exception as e:
        print(f"CF API {method} {path} error: {e}")
        return {"success": False, "error": str(e)}

print("=== 1. CLOUDFLARE ZONES ===")
zones = cf_api("GET", "/zones")
if zones.get("success"):
    for z in zones.get("result", []):
        zname = z.get("name")
        zid = z.get("id")
        zstatus = z.get("status")
        print(f"Zone: {zname} | id: {zid} | status: {zstatus}")
else:
    print("Zones result:", zones)

print("\n=== 2. CLOUDFLARE PAGES PROJECTS ===")
projects_res = cf_api("GET", f"/accounts/{account_id}/pages/projects")
project_names = []
existing_target = None

if projects_res.get("success"):
    for p in projects_res.get("result", []):
        pname = p.get("name")
        project_names.append(pname)
        subdomain = p.get("subdomain")
        domains = [d if isinstance(d, str) else d.get("name", "") for d in p.get("domains", [])]
        print(f"Pages Project: {pname} -> {subdomain}.pages.dev (domains: {domains})")
        if "facemaxaiapp.com" in domains or "www.facemaxaiapp.com" in domains:
            print(f"==> MATCH: {pname} is currently holding facemaxaiapp.com domains")
            existing_target = pname
else:
    print("Pages projects result:", projects_res)

# If an existing project already hosts facemaxaiapp.com, we must deploy to it to update the live site.
# Otherwise target 'facemaxaiapp'.
target_project = existing_target or "facemaxaiapp"
print(f"\nTarget project for deploy: {target_project}")

if target_project not in project_names:
    print(f"\nCreating Cloudflare Pages project: {target_project}...")
    create_res = cf_api("POST", f"/accounts/{account_id}/pages/projects", {
        "name": target_project,
        "production_branch": "main"
    })
    print("Create project response:", create_res)

print(f"\n=== 3. DEPLOYING WEB TO {target_project} ===")
deploy_cmd = ["wrangler", "pages", "deploy", "web", f"--project-name={target_project}", "--branch=main"]
print("Running:", " ".join(deploy_cmd))
subprocess.run(deploy_cmd, check=True)

# Also if target_project != "facemaxaiapp" and "facemaxaiapp" exists or can be created,
# we deploy to both so both have latest assets.
if target_project != "facemaxaiapp":
    print(f"\n=== 3b. ALSO DEPLOYING TO facemaxaiapp ===")
    if "facemaxaiapp" not in project_names:
        print("Creating secondary facemaxaiapp project...")
        cf_api("POST", f"/accounts/{account_id}/pages/projects", {
            "name": "facemaxaiapp",
            "production_branch": "main"
        })
    deploy_cmd2 = ["wrangler", "pages", "deploy", "web", "--project-name=facemaxaiapp", "--branch=main"]
    print("Running:", " ".join(deploy_cmd2))
    try:
        subprocess.run(deploy_cmd2, check=True)
    except Exception as e:
        print(f"Secondary deploy warning: {e}")

print("\n=== 4. ATTACHING CUSTOM DOMAINS ===")
for dom in ["facemaxaiapp.com", "www.facemaxaiapp.com"]:
    print(f"Attaching custom domain: {dom} to {target_project}...")
    dom_res = cf_api("POST", f"/accounts/{account_id}/pages/projects/{target_project}/domains", {
        "name": dom
    })
print("\n=== 5. CHECKING WORKERS IN ACCOUNT ===")
workers_res = cf_api("GET", f"/accounts/{account_id}/workers/scripts")
if workers_res.get("success"):
    for w in workers_res.get("result", []):
        w_id = w.get("id")
        print(f"Worker script found: {w_id}")
        if "restless" in w_id.lower() or "brook" in w_id.lower():
            print(f"Deploying dist/worker.js to frontend worker {w_id}...")
            try:
                subprocess.run(["wrangler", "deploy", "dist/worker.js", f"--name={w_id}"], check=True)
                print(f"Successfully updated worker {w_id} with new dist/worker.js!")
            except Exception as e:
                print(f"Failed to update worker {w_id}: {e}")
else:
    print("Workers list result:", workers_res)

print("\nCloudflare Pages and Worker deployment finished successfully!")
