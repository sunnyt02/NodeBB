import db from '../database';
import meta from '../meta';
import utils from '../utils';
import slugify from '../slugify';
import translator from '../translator';
import plugins from '../plugins';
import cache from '../cache';

type ModifiedField = {
    hadOwnProperty: boolean,
    name: string,
    slug: string
}

export default function (Categories) {
    async function update(modified: {[key: number]: ModifiedField}) {
        const cids: string[] = Object.keys(modified);
        await Promise.all(cids.map(cid => updateCategory(cid, modified[cid])));
        return cids;
    }

    async function updateCategory(cid: string, modifiedFields: ModifiedField) {
        const exists: boolean = await Categories.exists(cid);
        if (!exists) {
            return;
        }

        if (modifiedFields.hasOwnProperty('name')) {
            const translated: string | void | number = await translator.translate(modifiedFields.name);
            modifiedFields.slug = `${cid}/${slugify(translated)}`;
        }
        const result: {cid, category} = await plugins.hooks.fire('filter:category.update', { cid: cid, category: modifiedFields });

        const { category } = result;
        const fields: string[] = Object.keys(category);
        // move parent to front, so its updated first
        const parentCidIndex: number = fields.indexOf('parentCid');
        if (parentCidIndex !== -1 && fields.length > 1) {
            fields.splice(0, 0, fields.splice(parentCidIndex, 1)[0]);
        }

        for (const key of fields) {
            // eslint-disable-next-line no-await-in-loop
            await updateCategoryField(cid, key, category[key]);
        }
        plugins.hooks.fire('action:category.update', { cid: cid, modified: category });
    }

    async function updateCategoryField(cid: string, key: string, value: string) {
        if (key === 'parentCid') {
            return await updateParent(cid, value);
        } else if (key === 'tagWhitelist') {
            return await updateTagWhitelist(cid, value);
        } else if (key === 'name') {
            return await updateName(cid, value);
        } else if (key === 'order') {
            return await updateOrder(cid, value);
        }

        await db.setObjectField(`category:${cid}`, key, value);
        if (key === 'description') {
            await Categories.parseDescription(cid, value);
        }
    }

    async function updateParent(cid: string, newParent: string) {
        const parent: number = parseInt(newParent, 10) || 0;
        if (parseInt(cid, 10) === parent) {
            throw new Error('[[error:cant-set-self-as-parent]]');
        }
        const childrenCids = await Categories.getChildrenCids(cid);
        if (childrenCids.includes(newParent)) {
            throw new Error('[[error:cant-set-child-as-parent]]');
        }
        const categoryData = await Categories.getCategoryFields(cid, ['parentCid', 'order']);
        const oldParent = categoryData.parentCid;
        if (oldParent === newParent) {
            return;
        }
        await Promise.all([
            db.sortedSetRemove(`cid:${oldParent}:children`, cid),
            db.sortedSetAdd(`cid:${newParent}:children`, categoryData.order, cid),
            db.setObjectField(`category:${cid}`, 'parentCid', newParent),
        ]);

        cache.del([
            `cid:${oldParent}:children`,
            `cid:${newParent}:children`,
            `cid:${oldParent}:children:all`,
            `cid:${newParent}:children:all`,
        ]);
    }

    async function updateTagWhitelist(cid: string, tags: string) {
        const newTags: string[] = tags.split(',').map(tag => utils.cleanUpTag(tag, meta.config.maximumTagLength))
            .filter(Boolean);
        await db.delete(`cid:${cid}:tag:whitelist`);
        const scores: number[] = newTags.map((tag, index) => index);
        await db.sortedSetAdd(`cid:${cid}:tag:whitelist`, scores, tags);
        cache.del(`cid:${cid}:tag:whitelist`);
    }

    async function updateOrder(cid: string, order) {
        const parentCid = await Categories.getCategoryField(cid, 'parentCid');
        await db.sortedSetsAdd('categories:cid', order, cid);

        const childrenCids: number[] = await db.getSortedSetRange(
            `cid:${parentCid}:children`, 0, -1
        );

        const currentIndex: number = childrenCids.indexOf(Number(cid));
        if (currentIndex === -1) {
            throw new Error('[[error:no-category]]');
        }
        // moves cid to index order - 1 in the array
        if (childrenCids.length > 1) {
            childrenCids.splice(Math.max(0, order - 1), 0, childrenCids.splice(currentIndex, 1)[0]);
        }

        // recalculate orders from array indices
        await db.sortedSetAdd(
            `cid:${parentCid}:children`,
            childrenCids.map((cid, index) => index + 1),
            childrenCids
        );

        await db.setObjectBulk(
            childrenCids.map((cid, index) => [`category:${cid}`, { order: index + 1 }])
        );

        cache.del([
            'categories:cid',
            `cid:${parentCid}:children`,
            `cid:${parentCid}:children:all`,
        ]);
    }

    async function parseDescription(cid: string, description: string) {
        const parsedDescription: string = await plugins.hooks.fire('filter:parse.raw', description);
        await Categories.setCategoryField(cid, 'descriptionParsed', parsedDescription);
    };

    async function updateName(cid: string, newName: string) {
        const oldName: string = await Categories.getCategoryField(cid, 'name');
        await db.sortedSetRemove('categories:name', `${oldName.slice(0, 200).toLowerCase()}:${cid}`);
        await db.sortedSetAdd('categories:name', 0, `${newName.slice(0, 200).toLowerCase()}:${cid}`);
        await db.setObjectField(`category:${cid}`, 'name', newName);
    }
}